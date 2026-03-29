// push.js
import webpush from 'web-push';
import { store, persistData } from './data.js';

export function initVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL;
  if (!contact) {
    throw new Error('VAPID_CONTACT_EMAIL must be set in environment (e.g. mailto:admin@example.com)');
  }
  if (!publicKey || !privateKey) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set in environment');
  }
  webpush.setVapidDetails(contact, publicKey, privateKey);
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY;
}

export async function sendRoomPush(room) {
  const subs = store.pushSubscriptions;
  if (!subs || Object.keys(subs).length === 0) return;

  // Build set of currently-connected userIds — skip them (they see messages in real time)
  const activeUserIds = new Set(
    Array.from(store.activeConnections.values()).map(c => c.userId)
  );

  const payload = JSON.stringify({
    title: 'Alpine Team Chat',
    body: `New message in #${room}`,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { room },
  });

  const expiredEndpoints = [];

  for (const [userId, subscriptions] of Object.entries(subs)) {
    if (activeUserIds.has(userId)) continue;
    for (const sub of subscriptions) {
      if (!sub.rooms.includes(room)) continue;
      try {
        await webpush.sendNotification(sub.subscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredEndpoints.push({ userId, endpoint: sub.subscription.endpoint });
        } else {
          console.error('Push send error:', err.message);
        }
      }
    }
  }

  if (expiredEndpoints.length > 0) {
    for (const { userId, endpoint } of expiredEndpoints) {
      if (store.pushSubscriptions[userId]) {
        store.pushSubscriptions[userId] = store.pushSubscriptions[userId]
          .filter(s => s.subscription.endpoint !== endpoint);
        if (store.pushSubscriptions[userId].length === 0) {
          delete store.pushSubscriptions[userId];
        }
      }
    }
    await persistData();
  }
}

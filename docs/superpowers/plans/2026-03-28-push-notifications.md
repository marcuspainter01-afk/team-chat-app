# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Web Push notifications to Alpine Team Chat so users receive phone notifications for new messages in rooms they've opted into.

**Architecture:** VAPID-based Web Push API on the server (`push.js`), a service worker (`public/sw.js`) that wakes up on push events, per-room notification preferences stored per-device alongside each push subscription. Bell icons in the room sidebar let users toggle notifications per room. A PWA manifest enables "Add to Home Screen" on iOS/Android.

**Tech Stack:** Node.js `web-push` npm package, Web Push API, Service Worker API, PWA Web App Manifest

---

## Existing codebase context

- `server.js` — Express + WebSocket entry point, calls `await loadData()` before listen
- `data.js` — shared store, `loadData()`, `persistData()`
- `auth.js` — `requireAuth` middleware, `lookupToken()`
- `routes.js` — Express router, all API routes
- `websocket.js` — all WebSocket handlers, `broadcastToRoom()`
- `public/app.js` — ES module client; `renderRooms()` builds the sidebar room list
- `public/style.css` — all styles; `.room-item` has no `display: flex` yet

---

## Task 1: Install `web-push` and generate VAPID keys

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `.env` (manual step — user must add real keys)

- [ ] **Step 1: Install web-push**

```bash
cd /Users/marcuspainter/team-chat-app && npm install web-push
```

Expected: `added N packages` with no errors.

- [ ] **Step 2: Generate VAPID key pair**

```bash
npx web-push generate-vapid-keys --urlsafe-base64
```

Expected output:
```
=======================================
Public Key:
BNx... (87 chars)

Private Key:
abc... (43 chars)
=======================================
```

Copy both values — you'll need them in Step 3.

- [ ] **Step 3: Add VAPID keys to `.env`**

Open `/Users/marcuspainter/team-chat-app/.env` and add these three lines (using the keys from Step 2):

```
VAPID_PUBLIC_KEY=BNx...your-public-key...
VAPID_PRIVATE_KEY=abc...your-private-key...
VAPID_CONTACT_EMAIL=admin@alpinekansascity.com
```

- [ ] **Step 4: Update `.env.example`**

Read `/Users/marcuspainter/team-chat-app/.env.example`, then add:

```
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
VAPID_CONTACT_EMAIL=admin@alpinekansascity.com
```

- [ ] **Step 5: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add package.json package-lock.json .env.example
git commit -m "feat: install web-push, add VAPID env var placeholders"
```

---

## Task 2: Create `push.js`

**Files:**
- Create: `push.js`

- [ ] **Step 1: Create `push.js`**

```javascript
// push.js
import webpush from 'web-push';
import { store, persistData } from './data.js';

export function initVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@alpinekansascity.com';
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
```

- [ ] **Step 2: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add push.js
git commit -m "feat: add push.js — VAPID setup and sendRoomPush"
```

---

## Task 3: Update `data.js` — add `pushSubscriptions` to store

**Files:**
- Modify: `data.js`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/data.js` to see the current store definition and `loadData`/`persistData` implementations.

- [ ] **Step 2: Add `pushSubscriptions` to store**

In the `store` export, add `pushSubscriptions: {}` after `tokenIndex`:

```javascript
export const store = {
  users: {},
  messages: [],
  rooms: { general: { name: 'general', createdAt: new Date().toISOString() } },
  activeConnections: new Map(),
  tokenIndex: new Map(),
  pushSubscriptions: {},
};
```

- [ ] **Step 3: Load `push.json` in `loadData`**

Inside `loadData()`, after the rooms loading block, add:

```javascript
const pushFile = path.join(DATA_DIR, 'push.json');
if (await fileExists(pushFile)) {
  store.pushSubscriptions = JSON.parse(await fs.readFile(pushFile, 'utf-8'));
}
```

- [ ] **Step 4: Persist `push.json` in `persistData`**

Inside `persistData()`, add a fourth write after the rooms write:

```javascript
await fs.writeFile(path.join(DATA_DIR, 'push.json'), JSON.stringify(store.pushSubscriptions, null, 2));
```

- [ ] **Step 5: Verify the file looks correct**

The `persistData` function should now write four files: `users.json`, `messages.json`, `rooms.json`, `push.json`.

- [ ] **Step 6: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add data.js
git commit -m "feat: add pushSubscriptions to store, persist to push.json"
```

---

## Task 4: Update `auth.js` — attach `req.user` in `requireAuth`

**Files:**
- Modify: `auth.js`

This enables push API routes to access `req.user.id` without re-parsing the token.

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/auth.js`.

- [ ] **Step 2: Update `requireAuth`**

Replace the current `requireAuth` export with:

```javascript
export function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = token ? lookupToken(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add auth.js
git commit -m "feat: attach req.user in requireAuth middleware"
```

---

## Task 5: Update `routes.js` — add push API endpoints

**Files:**
- Modify: `routes.js`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/routes.js`.

- [ ] **Step 2: Add import for push helpers**

At the top of `routes.js`, add after the existing imports:

```javascript
import { getVapidPublicKey } from './push.js';
```

- [ ] **Step 3: Add the three push routes inside `createRouter()`**

Add these three routes at the end of `createRouter()`, before the `return router` line:

```javascript
  // Get VAPID public key (auth required)
  router.get('/push/vapid-public-key', requireAuth, (req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  // Subscribe: store push subscription + initial room list (auth required)
  router.post('/push/subscribe', requireAuth, async (req, res) => {
    const { subscription, rooms } = req.body;
    if (!subscription || !subscription.endpoint || !Array.isArray(rooms)) {
      return res.status(400).json({ error: 'subscription and rooms required' });
    }
    const userId = req.user.id;
    if (!store.pushSubscriptions[userId]) {
      store.pushSubscriptions[userId] = [];
    }
    const existing = store.pushSubscriptions[userId].findIndex(
      s => s.subscription.endpoint === subscription.endpoint
    );
    if (existing !== -1) {
      store.pushSubscriptions[userId][existing] = { subscription, rooms };
    } else {
      store.pushSubscriptions[userId].push({ subscription, rooms });
    }
    await persistData();
    res.status(204).end();
  });

  // Update rooms for an existing subscription (auth required)
  router.put('/push/rooms', requireAuth, async (req, res) => {
    const { endpoint, rooms } = req.body;
    if (!endpoint || !Array.isArray(rooms)) {
      return res.status(400).json({ error: 'endpoint and rooms required' });
    }
    const userId = req.user.id;
    const subs = store.pushSubscriptions[userId] || [];
    const sub = subs.find(s => s.subscription.endpoint === endpoint);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    sub.rooms = rooms;
    await persistData();
    res.status(204).end();
  });
```

- [ ] **Step 4: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add routes.js
git commit -m "feat: add push subscription API routes"
```

---

## Task 6: Update `websocket.js` — call `sendRoomPush` after new message

**Files:**
- Modify: `websocket.js`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/websocket.js`.

- [ ] **Step 2: Add import**

At the top of `websocket.js`, add after the existing imports:

```javascript
import { sendRoomPush } from './push.js';
```

- [ ] **Step 3: Call `sendRoomPush` after broadcasting a new message**

In the `case 'message':` handler, after the `broadcastToRoom(...)` call, add:

```javascript
sendRoomPush(currentRoom).catch(err => console.error('Push error:', err));
```

The full `case 'message':` block should end like:

```javascript
            await persistData();
            broadcastToRoom(currentRoom, { type: 'message', ...chatMessage });
            sendRoomPush(currentRoom).catch(err => console.error('Push error:', err));
            break;
```

Note: `sendRoomPush` is intentionally NOT awaited — we don't want to block the WebSocket response while push is sending to potentially slow external services.

- [ ] **Step 4: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add websocket.js
git commit -m "feat: trigger sendRoomPush after new messages"
```

---

## Task 7: Update `server.js` — call `initVapid()` on startup

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/server.js`.

- [ ] **Step 2: Add import**

Add after the existing imports:

```javascript
import { initVapid } from './push.js';
```

- [ ] **Step 3: Call `initVapid()` before `loadData()`**

Add this line before `await loadData()`:

```javascript
initVapid();
```

The startup sequence should be:

```javascript
initVapid();
await loadData();

server.listen(PORT, () => {
  console.log(`Alpine Team Chat running on http://localhost:${PORT}`);
});
```

- [ ] **Step 4: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add server.js
git commit -m "feat: initialize VAPID keys on server startup"
```

---

## Task 8: Generate icons and create `public/manifest.json`

**Files:**
- Create: `scripts/generate-icons.js`
- Create: `public/icon-192.png`
- Create: `public/icon-512.png`
- Create: `public/manifest.json`

- [ ] **Step 1: Create `scripts/generate-icons.js`**

```javascript
// scripts/generate-icons.js
// Generates solid-color PNG icons with no external dependencies.
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcVal]);
}

function solidPng(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB color type

  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      raw[base + 1 + x * 3] = r;
      raw[base + 1 + x * 3 + 1] = g;
      raw[base + 1 + x * 3 + 2] = b;
    }
  }

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Alpine blue: #4a9eff = rgb(74, 158, 255)
mkdirSync(path.join(__dirname, '../public'), { recursive: true });
writeFileSync(path.join(__dirname, '../public/icon-192.png'), solidPng(192, 74, 158, 255));
writeFileSync(path.join(__dirname, '../public/icon-512.png'), solidPng(512, 74, 158, 255));
console.log('Icons generated: public/icon-192.png, public/icon-512.png');
```

- [ ] **Step 2: Run the icon generator**

```bash
cd /Users/marcuspainter/team-chat-app && node scripts/generate-icons.js
```

Expected:
```
Icons generated: public/icon-192.png, public/icon-512.png
```

Verify: `ls -lh public/icon-*.png` — should show two files, each several KB.

- [ ] **Step 3: Create `public/manifest.json`**

```json
{
  "name": "Alpine Team Chat",
  "short_name": "Alpine Chat",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1d26",
  "theme_color": "#1a1d26",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add scripts/generate-icons.js public/icon-192.png public/icon-512.png public/manifest.json
git commit -m "feat: add PWA manifest and generated icons"
```

---

## Task 9: Create `public/sw.js` — service worker

**Files:**
- Create: `public/sw.js`

- [ ] **Step 1: Create `public/sw.js`**

```javascript
// public/sw.js

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Alpine Team Chat';
  const options = {
    body: data.body || 'New message',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.data?.room || 'default',  // collapses multiple notifications per room into one
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const room = event.notification.data?.room;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if (room) client.postMessage({ type: 'navigate_room', room });
          return client.focus();
        }
      }
      // Otherwise open a new window, passing room as query param
      const url = self.location.origin + (room ? `/?room=${encodeURIComponent(room)}` : '/');
      return clients.openWindow(url);
    })
  );
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add public/sw.js
git commit -m "feat: add service worker for push notifications"
```

---

## Task 10: Update `public/style.css` — bell icon and iOS banner styles

**Files:**
- Modify: `public/style.css`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/public/style.css` — specifically the `.room-item` rule.

- [ ] **Step 2: Update `.room-item` to flex and add bell + banner styles**

Find the `.room-item` rule and replace it with:

```css
.room-item {
  padding: 10px 15px;
  margin: 5px 0;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
```

Then add these new rules at the end of the file:

```css
/* Room name span (pushes bell to the right) */
.room-name { flex: 1; }

/* Bell notification toggle */
.room-bell-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
  line-height: 1;
}
.room-item:hover .room-bell-btn { opacity: 1; }
.room-bell-btn.bell-active { opacity: 1; }

/* iOS install banner */
.ios-banner {
  background: #2a2f3a;
  color: #ddd;
  padding: 10px 16px;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #3a3f4a;
  line-height: 1.4;
}
.ios-banner strong { color: white; }
.ios-banner-close {
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
  font-size: 18px;
  flex-shrink: 0;
  padding: 0 4px;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add public/style.css
git commit -m "feat: add bell icon and iOS banner styles"
```

---

## Task 11: Update `public/index.html` — manifest link + apple meta tags

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/public/index.html`.

- [ ] **Step 2: Add manifest and apple meta tags to `<head>`**

After `<link rel="stylesheet" href="style.css">`, add:

```html
  <link rel="manifest" href="manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Alpine Chat">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <meta name="theme-color" content="#1a1d26">
```

- [ ] **Step 3: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add public/index.html
git commit -m "feat: add PWA manifest link and apple meta tags"
```

---

## Task 12: Update `public/app.js` — SW registration, bell icons, permission flow, iOS banner

**Files:**
- Modify: `public/app.js`

This is the largest change. Read the file first to understand the current structure, then apply changes in order.

- [ ] **Step 1: Read the current file**

Read `/Users/marcuspainter/team-chat-app/public/app.js`.

- [ ] **Step 2: Add push state variables**

After the existing module-level variables (`let token`, `let userId`, etc.), add:

```javascript
let pushSubscription = null;    // browser PushSubscription object
let subscribedRooms = new Set(); // rooms this device wants notifications for
let vapidPublicKey = null;
```

- [ ] **Step 3: Add `initPush()` function**

Add after the `init()` function:

```javascript
async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    // Handle navigate_room messages from the service worker (notification click)
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate_room') switchRoom(e.data.room);
    });

    // Fetch VAPID public key
    const res = await fetch('/api/push/vapid-public-key', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const { publicKey } = await res.json();
    vapidPublicKey = publicKey;

    // Restore existing subscription and subscribed rooms from localStorage
    pushSubscription = await reg.pushManager.getSubscription();
    const stored = localStorage.getItem('subscribedRooms');
    if (pushSubscription && stored) {
      subscribedRooms = new Set(JSON.parse(stored));
    } else if (!pushSubscription) {
      subscribedRooms = new Set();
      localStorage.removeItem('subscribedRooms');
    }

    // Handle room from notification click (query param set by SW when opening new window)
    const roomParam = new URLSearchParams(window.location.search).get('room');
    if (roomParam && roomParam !== currentRoom) switchRoom(roomParam);

    showIosBanner();
  } catch (err) {
    console.error('Push init error:', err);
  }
}
```

- [ ] **Step 4: Add `toggleRoomBell()` and helpers**

Add after `initPush()`:

```javascript
async function toggleRoomBell(room, bellBtn) {
  if (!vapidPublicKey) return;

  if (Notification.permission === 'denied') {
    alert('Notifications are blocked. Check your browser settings to enable them.');
    return;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
  }

  if (!pushSubscription) {
    // First subscription on this device — create it
    const reg = await navigator.serviceWorker.ready;
    pushSubscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    subscribedRooms.add(room);
    localStorage.setItem('subscribedRooms', JSON.stringify([...subscribedRooms]));
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ subscription: pushSubscription.toJSON(), rooms: [...subscribedRooms] }),
    });
  } else {
    // Update existing subscription's room list
    if (subscribedRooms.has(room)) {
      subscribedRooms.delete(room);
    } else {
      subscribedRooms.add(room);
    }
    localStorage.setItem('subscribedRooms', JSON.stringify([...subscribedRooms]));
    await fetch('/api/push/rooms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ endpoint: pushSubscription.endpoint, rooms: [...subscribedRooms] }),
    });
  }

  updateBellButton(bellBtn, subscribedRooms.has(room));
}

function updateBellButton(btn, isSubscribed) {
  btn.textContent = isSubscribed ? '🔔' : '🔕';
  btn.title = isSubscribed ? 'Turn off notifications' : 'Turn on notifications';
  btn.classList.toggle('bell-active', isSubscribed);
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function showIosBanner() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (!isIos || isStandalone || localStorage.getItem('ios-banner-dismissed')) return;

  const banner = document.createElement('div');
  banner.className = 'ios-banner';

  const msg = document.createElement('span');
  msg.textContent = 'To enable notifications on iOS: tap ';
  const share = document.createElement('strong');
  share.textContent = 'Share';
  const mid = document.createTextNode(' then ');
  const add = document.createElement('strong');
  add.textContent = 'Add to Home Screen';
  msg.appendChild(share);
  msg.appendChild(mid);
  msg.appendChild(add);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ios-banner-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    banner.remove();
    localStorage.setItem('ios-banner-dismissed', '1');
  });

  banner.appendChild(msg);
  banner.appendChild(closeBtn);
  document.body.insertBefore(banner, document.body.firstChild);
}
```

- [ ] **Step 5: Update `init()` to call `initPush()` after `showChat()`**

Find the `if (data.valid)` block inside `init()`. After `loadMessages();`, add:

```javascript
        initPush();
```

The block should look like:

```javascript
      if (data.valid) {
        userId = data.userId;
        username = data.username;
        document.getElementById('user-avatar').src = data.avatar;
        showChat();
        connectWebSocket();
        loadRooms();
        loadMessages();
        initPush();
```

Also add `initPush();` at the same position in the login and register handlers (after `loadMessages();`).

- [ ] **Step 6: Update `renderRooms()` to add bell buttons**

Replace the current `renderRooms` function with:

```javascript
function renderRooms(rooms) {
  const list = document.getElementById('rooms-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.name === currentRoom ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'room-name';
    nameSpan.textContent = '# ' + r.name;
    div.appendChild(nameSpan);
    div.addEventListener('click', () => switchRoom(r.name));

    if ('PushManager' in window && vapidPublicKey) {
      const isSubscribed = subscribedRooms.has(r.name);
      const bellBtn = document.createElement('button');
      bellBtn.className = 'room-bell-btn' + (isSubscribed ? ' bell-active' : '');
      bellBtn.textContent = isSubscribed ? '🔔' : '🔕';
      bellBtn.title = isSubscribed ? 'Turn off notifications' : 'Turn on notifications';
      bellBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRoomBell(r.name, bellBtn);
      });
      div.appendChild(bellBtn);
    }

    list.appendChild(div);
  });
}
```

- [ ] **Step 7: Commit**

```bash
cd /Users/marcuspainter/team-chat-app && git add public/app.js
git commit -m "feat: add push notification client — SW registration, bell icons, iOS banner"
```

---

## Task 13: Smoke test locally

**Files:** None (verification only)

- [ ] **Step 1: Start the server**

```bash
cd /Users/marcuspainter/team-chat-app && npm start
```

Expected: `Alpine Team Chat running on http://localhost:3000`

If you see `VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set` — the `.env` keys are missing. Add them per Task 1 Step 3.

- [ ] **Step 2: Verify push endpoints**

```bash
# Get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"pushtest","email":"pushtest@alpinekansascity.com","password":"testpass1"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Should return {"publicKey":"B..."}
curl -s http://localhost:3000/api/push/vapid-public-key \
  -H "Authorization: Bearer $TOKEN"

# Should return 401
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/push/vapid-public-key
```

Expected: JSON with `publicKey`, then `401`.

- [ ] **Step 3: Verify manifest and SW are served**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/manifest.json
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/sw.js
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/icon-192.png
```

Expected: `200 200 200`

- [ ] **Step 4: Open browser and check PWA**

Open http://localhost:3000 in Chrome. Open DevTools → Application → Service Workers — confirm `sw.js` is registered. Check Application → Manifest — confirm it loads without errors.

- [ ] **Step 5: Clean up test data**

```bash
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
rm -f /Users/marcuspainter/team-chat-app/data/users.json \
      /Users/marcuspainter/team-chat-app/data/messages.json \
      /Users/marcuspainter/team-chat-app/data/push.json
```

---

## Task 14: Add VAPID keys to Railway and deploy

**Files:** None (deployment)

- [ ] **Step 1: Add VAPID environment variables in Railway dashboard**

Go to the Railway dashboard → your service → Variables tab. Add:
- `VAPID_PUBLIC_KEY` — the public key from Task 1 Step 2
- `VAPID_PRIVATE_KEY` — the private key from Task 1 Step 2
- `VAPID_CONTACT_EMAIL` — `admin@alpinekansascity.com`

- [ ] **Step 2: Push to GitHub (triggers auto-deploy)**

```bash
cd /Users/marcuspainter/team-chat-app && git push
```

- [ ] **Step 3: Wait for deploy and verify**

```bash
sleep 60

# Homepage loads
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/
# Expected: 200

# Manifest served
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/manifest.json
# Expected: 200

# SW served
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/sw.js
# Expected: 200

# Push endpoint returns 401 (not 500 — confirms VAPID initialized correctly)
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/api/push/vapid-public-key
# Expected: 401
```

- [ ] **Step 4: Test on phone**

1. Open https://chat.alpinekansascity.com in Chrome on Android (or Safari on iOS 16.4+)
2. Log in
3. On iOS: tap Share → Add to Home Screen → open from home screen
4. Hover over a room → tap 🔕 → allow notifications when prompted
5. Have another device send a message to that room
6. Confirm notification appears on lock screen: `"New message in #general"`

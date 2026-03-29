// routes.js
import { Router } from 'express';
import crypto from 'crypto';
import { store, persistData } from './data.js';
import { hashPassword, verifyPassword, generateToken, lookupToken, requireAuth } from './auth.js';
import { broadcastRooms } from './websocket.js';
import { getVapidPublicKey } from './push.js';

export function createRouter() {
  const router = Router();

  // Register
  router.post('/register', async (req, res) => {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters, letters, numbers and underscores only' });
    }
    const FORBIDDEN_USERNAMES = new Set(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']);
    if (FORBIDDEN_USERNAMES.has(username)) {
      return res.status(400).json({ error: 'Username not allowed' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!email.toLowerCase().endsWith('@alpinekansascity.com')) {
      return res.status(403).json({ error: 'Registration is restricted to @alpinekansascity.com email addresses' });
    }
    if (Object.hasOwn(store.users, username)) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const userId = crypto.randomBytes(8).toString('hex');
    const token = generateToken();

    store.users[username] = {
      id: userId,
      username,
      email: email.toLowerCase(),
      password: await hashPassword(password),
      token,
      tokenCreatedAt: Date.now(),
      createdAt: new Date().toISOString(),
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random`,
    };

    store.tokenIndex.set(token, username);
    await persistData();

    res.json({ token, userId, username, avatar: store.users[username].avatar });
  });

  // Login
  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = Object.hasOwn(store.users, username) ? store.users[username] : null;
    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken();
    if (user.token) store.tokenIndex.delete(user.token);
    user.token = token;
    user.tokenCreatedAt = Date.now();
    store.tokenIndex.set(token, username);
    await persistData();
    res.json({ token, userId: user.id, username, avatar: user.avatar });
  });

  // Verify token
  router.post('/verify', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const user = lookupToken(token);
    if (!user) return res.status(401).json({ valid: false });
    res.json({ valid: true, userId: user.id, username: user.username, avatar: user.avatar });
  });

  // Get messages for a room (auth required)
  router.get('/messages/:room', requireAuth, (req, res) => {
    const { room } = req.params;
    if (!store.rooms[room]) return res.status(404).json({ error: 'Room not found' });
    res.json(store.messages.filter(m => m.room === room));
  });

  // Get all rooms (auth required)
  router.get('/rooms', requireAuth, (req, res) => {
    res.json(Object.values(store.rooms));
  });

  // Create room (auth required)
  router.post('/rooms', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (!/^[a-zA-Z0-9-]{1,30}$/.test(name)) {
      return res.status(400).json({ error: 'Room name must be 1-30 characters, letters, numbers and hyphens only' });
    }
    if (store.rooms[name]) return res.status(409).json({ error: 'Room already exists' });

    store.rooms[name] = { name, createdAt: new Date().toISOString() };
    await persistData();
    broadcastRooms();
    res.json(store.rooms[name]);
  });

  // Global search (auth required)
  router.get('/search', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);

    const results = store.messages
      .filter(m => !m.deleted && m.text.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 50)
      .map(m => ({ room: m.room, messageId: m.id, username: m.username, text: m.text, timestamp: m.timestamp }));

    res.json(results);
  });

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
    try {
      const url = new URL(subscription.endpoint);
      if (url.protocol !== 'https:') throw new Error();
    } catch {
      return res.status(400).json({ error: 'Invalid subscription endpoint' });
    }
    const userId = req.user.id;
    if (!Object.hasOwn(store.pushSubscriptions, userId)) {
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

  return router;
}

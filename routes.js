// routes.js
import { Router } from 'express';
import crypto from 'crypto';
import { store, persistData } from './data.js';
import { hashPassword, verifyPassword, generateToken, lookupToken, requireAuth } from './auth.js';
import { broadcastRooms } from './websocket.js';

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
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!email.toLowerCase().endsWith('@alpinekansascity.com')) {
      return res.status(403).json({ error: 'Registration is restricted to @alpinekansascity.com email addresses' });
    }
    if (store.users[username]) {
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
      createdAt: new Date(),
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
    const user = store.users[username];
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
    const user = lookupToken(token);
    if (!user) return res.status(401).json({ valid: false });
    res.json({ valid: true, userId: user.id, username: user.username, avatar: user.avatar });
  });

  // Get messages for a room (auth required)
  router.get('/messages/:room', requireAuth, (req, res) => {
    const { room } = req.params;
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

    store.rooms[name] = { name, createdAt: new Date() };
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

  return router;
}

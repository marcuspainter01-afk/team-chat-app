# Tier 1 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `team-chat-app.js` into focused modules, then add message editing/deletion, emoji reactions, and global message search.

**Architecture:** Split the monolithic single file into `data.js` (store + persistence), `auth.js` (token/bcrypt helpers), `routes.js` (Express routes), `websocket.js` (WebSocket handlers), `server.js` (entry point), and `public/` (static frontend). New features are added on top of the clean structure.

**Tech Stack:** Node.js 18+, Express 4, ws 8, bcrypt, helmet, express-rate-limit, emoji-picker-element (CDN)

---

## Phase 1: Modular Refactor

### Task 1: Create `data.js`

**Files:**
- Create: `data.js`

- [ ] **Step 1: Create `data.js` with the shared store, persistence, and constants**

```javascript
// data.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = path.join(__dirname, 'data');
export const MAX_MESSAGES_PER_ROOM = 1000;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const store = {
  users: {},
  messages: [],
  rooms: { general: { name: 'general', createdAt: new Date() } },
  activeConnections: new Map(), // ws → { userId, username, currentRoom }
  tokenIndex: new Map(),        // token → username
};

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const usersFile = path.join(DATA_DIR, 'users.json');
    const messagesFile = path.join(DATA_DIR, 'messages.json');
    const roomsFile = path.join(DATA_DIR, 'rooms.json');

    if (await fileExists(usersFile)) {
      store.users = JSON.parse(await fs.readFile(usersFile, 'utf-8'));
    }
    if (await fileExists(messagesFile)) {
      store.messages = JSON.parse(await fs.readFile(messagesFile, 'utf-8'));
    }
    if (await fileExists(roomsFile)) {
      store.rooms = JSON.parse(await fs.readFile(roomsFile, 'utf-8'));
    }

    // Rebuild token index from loaded users
    store.tokenIndex.clear();
    for (const [username, user] of Object.entries(store.users)) {
      if (user.token) store.tokenIndex.set(user.token, username);
    }
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

export async function persistData() {
  try {
    await fs.writeFile(path.join(DATA_DIR, 'users.json'), JSON.stringify(store.users, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'messages.json'), JSON.stringify(store.messages, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'rooms.json'), JSON.stringify(store.rooms, null, 2));
  } catch (err) {
    console.error('Error persisting data:', err);
    throw err;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add data.js
git commit -m "refactor: extract data store and persistence to data.js"
```

---

### Task 2: Create `auth.js`

**Files:**
- Create: `auth.js`

- [ ] **Step 1: Create `auth.js` with token/bcrypt helpers and auth middleware**

```javascript
// auth.js
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { store, TOKEN_TTL_MS } from './data.js';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function lookupToken(token) {
  const username = store.tokenIndex.get(token);
  if (!username) return null;
  const user = store.users[username];
  if (!user) return null;
  if (Date.now() - (user.tokenCreatedAt || 0) > TOKEN_TTL_MS) return null;
  return user;
}

export function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !lookupToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

- [ ] **Step 2: Commit**

```bash
git add auth.js
git commit -m "refactor: extract auth helpers and middleware to auth.js"
```

---

### Task 3: Create `websocket.js`

**Files:**
- Create: `websocket.js`

- [ ] **Step 1: Create `websocket.js` with all WebSocket handling and broadcast helpers**

```javascript
// websocket.js
import crypto from 'crypto';
import { store, persistData, MAX_MESSAGES_PER_ROOM } from './data.js';
import { lookupToken } from './auth.js';

let _wss = null;

export function setupWebSocket(wss) {
  _wss = wss;

  wss.on('connection', (ws) => {
    let userId = null;
    let username = null;
    let currentRoom = 'general';

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.type) {
          case 'auth': {
            const user = lookupToken(msg.token);
            if (!user) {
              ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid or expired token' }));
              ws.close();
              return;
            }
            userId = user.id;
            username = user.username;
            store.activeConnections.set(ws, { userId, username, currentRoom });
            broadcastUserStatus();
            ws.send(JSON.stringify({ type: 'auth_success', userId, username }));
            break;
          }

          case 'join_room':
            if (!userId) return;
            currentRoom = msg.room;
            store.activeConnections.set(ws, { userId, username, currentRoom });
            broadcastUserStatus();
            break;

          case 'message': {
            if (!userId) return;
            const chatMessage = {
              id: crypto.randomBytes(8).toString('hex'),
              userId,
              username,
              room: currentRoom,
              text: String(msg.text).slice(0, 2000),
              avatar: store.users[username]?.avatar,
              timestamp: new Date().toISOString(),
              reactions: {},
            };
            store.messages.push(chatMessage);

            // Cap messages per room
            const roomMsgs = store.messages.filter(m => m.room === currentRoom);
            if (roomMsgs.length > MAX_MESSAGES_PER_ROOM) {
              store.messages = store.messages.filter(m => m.room !== currentRoom)
                .concat(roomMsgs.slice(-MAX_MESSAGES_PER_ROOM));
            }

            await persistData();
            broadcast({ type: 'message', ...chatMessage });
            break;
          }

          case 'typing':
            if (!userId) return;
            broadcastToRoom(currentRoom, { type: 'typing', username, room: currentRoom });
            break;

          case 'edit_message': {
            if (!userId) return;
            const m = store.messages.find(m => m.id === msg.messageId);
            if (!m || m.userId !== userId || m.deleted) return;
            m.text = String(msg.text).slice(0, 2000);
            m.editedAt = new Date().toISOString();
            await persistData();
            broadcastToRoom(m.room, { type: 'message_edited', messageId: m.id, text: m.text, editedAt: m.editedAt });
            break;
          }

          case 'delete_message': {
            if (!userId) return;
            const dm = store.messages.find(m => m.id === msg.messageId);
            if (!dm || dm.userId !== userId) return;
            dm.deleted = true;
            dm.text = '';
            await persistData();
            broadcastToRoom(dm.room, { type: 'message_deleted', messageId: dm.id });
            break;
          }

          case 'react': {
            if (!userId) return;
            const rm = store.messages.find(m => m.id === msg.messageId);
            if (!rm || rm.deleted) return;
            if (!rm.reactions) rm.reactions = {};
            const emoji = msg.emoji;
            if (!rm.reactions[emoji]) rm.reactions[emoji] = [];
            const idx = rm.reactions[emoji].indexOf(userId);
            if (idx === -1) {
              rm.reactions[emoji].push(userId);
            } else {
              rm.reactions[emoji].splice(idx, 1);
              if (rm.reactions[emoji].length === 0) delete rm.reactions[emoji];
            }
            await persistData();
            broadcastToRoom(rm.room, { type: 'reaction_updated', messageId: rm.id, reactions: rm.reactions });
            break;
          }
        }
      } catch (err) {
        console.error('WebSocket error:', err);
      }
    });

    ws.on('close', () => {
      store.activeConnections.delete(ws);
      broadcastUserStatus();
    });
  });
}

export function broadcast(msg) {
  const payload = JSON.stringify(msg);
  _wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

export function broadcastToRoom(room, msg) {
  const payload = JSON.stringify(msg);
  for (const [client, info] of store.activeConnections) {
    if (info.currentRoom === room && client.readyState === 1) {
      client.send(payload);
    }
  }
}

export function broadcastRooms() {
  broadcast({ type: 'rooms_updated', rooms: Object.values(store.rooms) });
}

export function broadcastUserStatus() {
  broadcast({ type: 'users_online', users: Array.from(store.activeConnections.values()) });
}
```

- [ ] **Step 2: Commit**

```bash
git add websocket.js
git commit -m "refactor: extract WebSocket handling to websocket.js (includes edit, delete, react handlers)"
```

---

### Task 4: Create `routes.js`

**Files:**
- Create: `routes.js`

- [ ] **Step 1: Create `routes.js` with all Express routes**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add routes.js
git commit -m "refactor: extract all API routes to routes.js (includes search endpoint)"
```

---

### Task 5: Create `public/style.css`

**Files:**
- Create: `public/style.css`

- [ ] **Step 1: Create the `public/` directory and `style.css` with all existing styles plus new ones for edit/delete, reactions, and search**

```bash
mkdir -p public
```

```css
/* public/style.css */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #f5f5f5;
  height: 100vh;
  overflow: hidden;
}

.container { display: flex; height: 100vh; }

/* Sidebar */
.sidebar {
  width: 250px;
  background: #1a1d26;
  color: white;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #2a2f3a;
}
.sidebar-header {
  padding: 20px;
  border-bottom: 1px solid #2a2f3a;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sidebar-header h1 { font-size: 18px; font-weight: 600; }
.search-icon-btn {
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
}
.search-icon-btn:hover { color: white; }
.rooms-list { flex: 1; overflow-y: auto; padding: 10px; }
.room-item {
  padding: 10px 15px;
  margin: 5px 0;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
  font-size: 14px;
}
.room-item:hover { background: #2a2f3a; }
.room-item.active { background: #4a9eff; font-weight: 600; }
.new-room-btn {
  margin: 10px;
  padding: 10px;
  background: #4a9eff;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
.new-room-btn:hover { background: #357abd; }
.sidebar-footer {
  padding: 15px;
  border-top: 1px solid #2a2f3a;
  display: flex;
  align-items: center;
  gap: 10px;
}
.user-avatar { width: 40px; height: 40px; border-radius: 50%; background: #4a9eff; }
.user-info { flex: 1; min-width: 0; }
.user-info p { font-size: 13px; color: #aaa; }
.user-info strong {
  display: block;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.logout-btn { background: none; border: none; color: #999; cursor: pointer; font-size: 16px; }

/* Main content */
.main-content { flex: 1; display: flex; flex-direction: column; background: white; overflow: hidden; }
.chat-header { padding: 20px; background: white; border-bottom: 1px solid #e5e5e5; }
.chat-header h2 { font-size: 18px; color: #1a1d26; }
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Messages */
.message { display: flex; gap: 10px; margin-bottom: 4px; position: relative; }
.message:hover .message-actions { opacity: 1; }
.message-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }
.message-body { flex: 1; }
.message-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.message-author { font-weight: 600; font-size: 14px; color: #1a1d26; }
.message-time { font-size: 12px; color: #999; }
.message-edited { font-size: 11px; color: #bbb; font-style: italic; }
.message-text { color: #1a1d26; line-height: 1.4; word-wrap: break-word; }
.message-text.deleted { color: #bbb; font-style: italic; }

/* Edit/delete actions */
.message-actions {
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  gap: 4px;
  margin-left: auto;
  align-self: flex-start;
}
.message-actions button {
  background: none;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 13px;
  color: #666;
}
.message-actions button:hover { background: #f5f5f5; }

/* Edit input */
.edit-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #4a9eff;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
}

/* Reactions */
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.reaction-pill {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 12px;
  border: 1px solid #e5e5e5;
  background: #f9f9f9;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}
.reaction-pill:hover { background: #eef4ff; border-color: #4a9eff; }
.reaction-pill.mine { background: #eef4ff; border-color: #4a9eff; }
.reaction-pill .count { font-size: 12px; color: #555; }
.react-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  color: #aaa;
  opacity: 0;
  transition: opacity 0.15s;
}
.message:hover .react-btn { opacity: 1; }
.react-btn:hover { color: #555; }

/* Emoji picker popover */
.emoji-picker-popover {
  position: absolute;
  z-index: 100;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  border-radius: 8px;
}

/* Highlight for search jump */
.message.highlight { background: #fffbe6; border-radius: 6px; transition: background 2s; }

/* Input area */
.input-area { padding: 20px; border-top: 1px solid #e5e5e5; background: white; }
.input-form { display: flex; gap: 10px; }
.input-form input {
  flex: 1;
  padding: 10px 15px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
}
.input-form input:focus { outline: none; border-color: #4a9eff; box-shadow: 0 0 0 3px rgba(74,158,255,0.1); }
.input-form button {
  padding: 10px 20px;
  background: #4a9eff;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}
.input-form button:hover { background: #357abd; }

/* Auth */
.auth-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.auth-box {
  background: white;
  padding: 40px;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.2);
  width: 100%;
  max-width: 380px;
}
.auth-box h1 { margin-bottom: 30px; color: #1a1d26; text-align: center; }
.auth-form { display: flex; flex-direction: column; gap: 15px; }
.auth-form input { padding: 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
.auth-form input:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102,126,234,0.1); }
.auth-form button {
  padding: 12px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}
.auth-form button:hover { background: #5568d3; }
.auth-toggle { text-align: center; font-size: 13px; color: #666; margin-top: 15px; }
.auth-toggle a { color: #667eea; cursor: pointer; text-decoration: underline; }
.error { padding: 12px; background: #fee; color: #c33; border-radius: 6px; font-size: 13px; }
.hidden { display: none; }

/* Search panel */
.search-bar-wrapper { padding: 12px 20px; border-bottom: 1px solid #e5e5e5; display: flex; gap: 8px; }
.search-bar-wrapper input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
}
.search-bar-wrapper input:focus { outline: none; border-color: #4a9eff; }
.search-close-btn { background: none; border: none; font-size: 18px; cursor: pointer; color: #999; }
.search-results { flex: 1; overflow-y: auto; padding: 16px; }
.search-result {
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.search-result:hover { background: #f5f9ff; border-color: #4a9eff; }
.search-result-meta { font-size: 12px; color: #999; margin-bottom: 4px; }
.search-result-text { font-size: 14px; color: #1a1d26; }
.search-result-text strong { background: #fff3cd; padding: 0 2px; border-radius: 2px; }
.search-empty { color: #999; font-size: 14px; text-align: center; margin-top: 40px; }

/* Scrollbar */
.scrollable::-webkit-scrollbar { width: 6px; }
.scrollable::-webkit-scrollbar-track { background: transparent; }
.scrollable::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
.scrollable::-webkit-scrollbar-thumb:hover { background: #bbb; }
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "refactor: extract styles to public/style.css (includes edit, reactions, search styles)"
```

---

### Task 6: Create `public/index.html`

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create the HTML shell**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alpine Team Chat</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <!-- Auth Screen -->
  <div id="auth-screen" class="auth-container">
    <div class="auth-box">
      <h1>Alpine Team Chat</h1>
      <div id="login-form" class="auth-form">
        <input type="text" id="login-username" placeholder="Username" />
        <input type="password" id="login-password" placeholder="Password" />
        <button id="login-btn">Sign In</button>
        <div class="auth-toggle">
          Don't have an account? <a id="toggle-to-register">Sign Up</a>
        </div>
        <div id="auth-error" class="error hidden"></div>
      </div>
      <div id="register-form" class="auth-form hidden">
        <input type="text" id="register-username" placeholder="Choose a username" />
        <input type="email" id="register-email" placeholder="your@alpinekansascity.com" />
        <input type="password" id="register-password" placeholder="Choose a password" />
        <input type="password" id="register-confirm" placeholder="Confirm password" />
        <button id="register-btn">Create Account</button>
        <div class="auth-toggle">
          Already have an account? <a id="toggle-to-login">Sign In</a>
        </div>
        <div id="auth-error-reg" class="error hidden"></div>
      </div>
    </div>
  </div>

  <!-- Chat Screen -->
  <div id="chat-screen" class="container hidden">
    <div class="sidebar scrollable">
      <div class="sidebar-header">
        <h1>Alpine Team Chat</h1>
        <button class="search-icon-btn" id="open-search-btn" title="Search">🔍</button>
      </div>
      <div class="rooms-list" id="rooms-list"></div>
      <button class="new-room-btn" id="new-room-btn">+ New Room</button>
      <div class="sidebar-footer">
        <img id="user-avatar" class="user-avatar" alt="avatar" />
        <div class="user-info">
          <strong id="username-display"></strong>
          <p>Online</p>
        </div>
        <button class="logout-btn" id="logout-btn">✕</button>
      </div>
    </div>

    <div class="main-content">
      <!-- Normal chat view -->
      <div id="chat-view">
        <div class="chat-header">
          <h2 id="room-name"></h2>
        </div>
        <div class="messages-container scrollable" id="messages"></div>
        <div class="input-area">
          <form class="input-form" id="message-form">
            <input type="text" id="message-input" placeholder="Type a message..." autocomplete="off" />
            <button type="submit">Send</button>
          </form>
        </div>
      </div>

      <!-- Search view (hidden by default) -->
      <div id="search-view" class="hidden" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
        <div class="search-bar-wrapper">
          <input type="text" id="search-input" placeholder="Search messages..." />
          <button class="search-close-btn" id="close-search-btn">✕</button>
        </div>
        <div class="search-results scrollable" id="search-results"></div>
      </div>
    </div>
  </div>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "refactor: extract HTML to public/index.html"
```

---

### Task 7: Create `public/app.js`

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Create `public/app.js` with all client-side logic including edit/delete, reactions, and search**

```javascript
// public/app.js
import 'https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js';

let token = localStorage.getItem('token');
let userId = null;
let username = null;
let currentRoom = 'general';
let ws = null;
let activeEmojiPicker = null; // track open picker to close on outside click

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  try {
    if (token) {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.valid) {
        userId = data.userId;
        username = data.username;
        document.getElementById('user-avatar').src = data.avatar;
        showChat();
        connectWebSocket();
        loadRooms();
        loadMessages();
      } else {
        localStorage.removeItem('token');
        showAuth();
      }
    } else {
      showAuth();
    }
  } catch (err) {
    console.error('Init error:', err);
    showAuth();
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('chat-screen').classList.add('hidden');
}

function showChat() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('chat-screen').classList.remove('hidden');
  document.getElementById('username-display').textContent = username;
  document.getElementById('room-name').textContent = '#' + currentRoom;
}

document.getElementById('toggle-to-register').addEventListener('click', () => {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.remove('hidden');
  clearAuthErrors();
});
document.getElementById('toggle-to-login').addEventListener('click', () => {
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  clearAuthErrors();
});

document.getElementById('login-btn').addEventListener('click', async () => {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value;
  const err = document.getElementById('auth-error');
  if (!u || !p) return showErr(err, 'Username and password required');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const data = await res.json();
  if (!res.ok) return showErr(err, data.error);

  token = data.token;
  userId = data.userId;
  username = data.username;
  localStorage.setItem('token', token);
  document.getElementById('user-avatar').src = data.avatar;
  showChat();
  connectWebSocket();
  loadRooms();
  loadMessages();
});

document.getElementById('register-btn').addEventListener('click', async () => {
  const u = document.getElementById('register-username').value.trim();
  const e = document.getElementById('register-email').value.trim();
  const p = document.getElementById('register-password').value;
  const c = document.getElementById('register-confirm').value;
  const err = document.getElementById('auth-error-reg');

  if (!u || !e || !p || !c) return showErr(err, 'All fields required');
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) return showErr(err, 'Username must be 3-30 characters, letters, numbers and underscores only');
  if (!e.toLowerCase().endsWith('@alpinekansascity.com')) return showErr(err, 'Must use an @alpinekansascity.com email address');
  if (p.length < 8) return showErr(err, 'Password must be at least 8 characters');
  if (p !== c) return showErr(err, 'Passwords do not match');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, email: e, password: p }),
  });
  const data = await res.json();
  if (!res.ok) return showErr(err, data.error);

  token = data.token;
  userId = data.userId;
  username = data.username;
  localStorage.setItem('token', token);
  document.getElementById('user-avatar').src = data.avatar;
  showChat();
  connectWebSocket();
  loadRooms();
  loadMessages();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  token = null;
  if (ws) ws.close();
  showAuth();
});

function showErr(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function clearAuthErrors() {
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-error-reg').classList.add('hidden');
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + window.location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
    ws.send(JSON.stringify({ type: 'join_room', room: currentRoom }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'message':
        if (msg.room === currentRoom) displayMessage(msg);
        break;
      case 'rooms_updated':
        renderRooms(msg.rooms);
        break;
      case 'message_edited':
        applyEdit(msg.messageId, msg.text, msg.editedAt);
        break;
      case 'message_deleted':
        applyDelete(msg.messageId);
        break;
      case 'reaction_updated':
        applyReactions(msg.messageId, msg.reactions);
        break;
    }
  };
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

async function loadRooms() {
  const res = await fetch('/api/rooms', { headers: { Authorization: 'Bearer ' + token } });
  renderRooms(await res.json());
}

function renderRooms(rooms) {
  const list = document.getElementById('rooms-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.name === currentRoom ? ' active' : '');
    div.textContent = '# ' + r.name;
    div.addEventListener('click', () => switchRoom(r.name));
    list.appendChild(div);
  });
}

function switchRoom(room) {
  currentRoom = room;
  document.getElementById('room-name').textContent = '#' + room;
  document.getElementById('messages').innerHTML = '';
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'join_room', room }));
  loadMessages();
  renderRooms([...document.querySelectorAll('.room-item')].map(el => ({ name: el.textContent.slice(2) })));
  loadRooms(); // re-render to update active state
}

document.getElementById('new-room-btn').addEventListener('click', async () => {
  const name = prompt('Room name (letters, numbers, hyphens):');
  if (!name) return;
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: name.toLowerCase().trim() }),
  });
  if (!res.ok) { const e = await res.json(); alert('Error: ' + e.error); }
  else loadRooms();
});

// ─── Messages ────────────────────────────────────────────────────────────────

async function loadMessages() {
  const res = await fetch(`/api/messages/${currentRoom}`, { headers: { Authorization: 'Bearer ' + token } });
  const msgs = await res.json();
  const container = document.getElementById('messages');
  container.innerHTML = '';
  msgs.forEach(displayMessage);
  container.scrollTop = container.scrollHeight;
}

document.getElementById('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'message', text }));
  input.value = '';
});

function displayMessage(msg) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message';
  div.dataset.id = msg.id;

  const avatar = document.createElement('img');
  avatar.src = msg.avatar || '';
  avatar.className = 'message-avatar';

  const body = document.createElement('div');
  body.className = 'message-body';

  // Header row
  const header = document.createElement('div');
  header.className = 'message-header';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = msg.username;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = new Date(msg.timestamp).toLocaleTimeString();
  header.appendChild(author);
  header.appendChild(time);

  if (msg.editedAt) {
    const edited = document.createElement('span');
    edited.className = 'message-edited';
    edited.textContent = `(edited ${new Date(msg.editedAt).toLocaleTimeString()})`;
    header.appendChild(edited);
  }

  // Text
  const textEl = document.createElement('div');
  textEl.className = 'message-text' + (msg.deleted ? ' deleted' : '');
  textEl.textContent = msg.deleted ? 'This message was deleted' : msg.text;

  // Reactions
  const reactionsEl = document.createElement('div');
  reactionsEl.className = 'reactions';
  renderReactionPills(reactionsEl, msg.id, msg.reactions || {});

  body.appendChild(header);
  body.appendChild(textEl);
  body.appendChild(reactionsEl);

  // Actions (edit/delete for own messages, react button for all)
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // React button
  if (!msg.deleted) {
    const reactBtn = document.createElement('button');
    reactBtn.className = 'react-btn';
    reactBtn.textContent = '😊';
    reactBtn.title = 'React';
    reactBtn.addEventListener('click', (e) => toggleEmojiPicker(e, msg.id, div));
    actions.appendChild(reactBtn);
  }

  if (msg.userId === userId && !msg.deleted) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => startEdit(msg.id, textEl));
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', () => {
      if (confirm('Delete this message?')) {
        ws.send(JSON.stringify({ type: 'delete_message', messageId: msg.id }));
      }
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
  }

  div.appendChild(avatar);
  div.appendChild(body);
  div.appendChild(actions);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ─── Edit & Delete ───────────────────────────────────────────────────────────

function startEdit(messageId, textEl) {
  const original = textEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = original;
  textEl.replaceWith(input);
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const newText = input.value.trim();
      if (newText && newText !== original) {
        ws.send(JSON.stringify({ type: 'edit_message', messageId, text: newText }));
      }
      const restored = document.createElement('div');
      restored.className = 'message-text';
      restored.textContent = newText || original;
      input.replaceWith(restored);
    } else if (e.key === 'Escape') {
      const restored = document.createElement('div');
      restored.className = 'message-text';
      restored.textContent = original;
      input.replaceWith(restored);
    }
  });
}

function applyEdit(messageId, text, editedAt) {
  const div = document.querySelector(`.message[data-id="${messageId}"]`);
  if (!div) return;
  const textEl = div.querySelector('.message-text');
  if (textEl) textEl.textContent = text;
  const header = div.querySelector('.message-header');
  let editedEl = header.querySelector('.message-edited');
  if (!editedEl) {
    editedEl = document.createElement('span');
    editedEl.className = 'message-edited';
    header.appendChild(editedEl);
  }
  editedEl.textContent = `(edited ${new Date(editedAt).toLocaleTimeString()})`;
}

function applyDelete(messageId) {
  const div = document.querySelector(`.message[data-id="${messageId}"]`);
  if (!div) return;
  const textEl = div.querySelector('.message-text');
  if (textEl) { textEl.textContent = 'This message was deleted'; textEl.classList.add('deleted'); }
  const actions = div.querySelector('.message-actions');
  if (actions) actions.innerHTML = '';
}

// ─── Reactions ───────────────────────────────────────────────────────────────

function renderReactionPills(container, messageId, reactions) {
  container.innerHTML = '';
  for (const [emoji, userIds] of Object.entries(reactions)) {
    if (userIds.length === 0) continue;
    const pill = document.createElement('button');
    pill.className = 'reaction-pill' + (userIds.includes(userId) ? ' mine' : '');
    pill.innerHTML = `${emoji} <span class="count">${userIds.length}</span>`;
    pill.addEventListener('click', () => ws.send(JSON.stringify({ type: 'react', messageId, emoji })));
    container.appendChild(pill);
  }
}

function applyReactions(messageId, reactions) {
  const div = document.querySelector(`.message[data-id="${messageId}"]`);
  if (!div) return;
  const reactionsEl = div.querySelector('.reactions');
  if (reactionsEl) renderReactionPills(reactionsEl, messageId, reactions);
}

function toggleEmojiPicker(e, messageId, messageDiv) {
  e.stopPropagation();
  if (activeEmojiPicker) { activeEmojiPicker.remove(); activeEmojiPicker = null; return; }

  const picker = document.createElement('emoji-picker');
  picker.className = 'emoji-picker-popover';

  // Position near the button
  const rect = e.target.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';

  picker.addEventListener('emoji-click', (ev) => {
    ws.send(JSON.stringify({ type: 'react', messageId, emoji: ev.detail.unicode }));
    picker.remove();
    activeEmojiPicker = null;
  });

  document.body.appendChild(picker);
  activeEmojiPicker = picker;
}

document.addEventListener('click', () => {
  if (activeEmojiPicker) { activeEmojiPicker.remove(); activeEmojiPicker = null; }
});

// ─── Search ──────────────────────────────────────────────────────────────────

document.getElementById('open-search-btn').addEventListener('click', openSearch);
document.getElementById('close-search-btn').addEventListener('click', closeSearch);

function openSearch() {
  document.getElementById('chat-view').classList.add('hidden');
  document.getElementById('search-view').classList.remove('hidden');
  document.getElementById('search-input').focus();
}

function closeSearch() {
  document.getElementById('search-view').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
}

document.getElementById('search-input').addEventListener('input', debounce(async (e) => {
  const q = e.target.value.trim();
  const container = document.getElementById('search-results');
  if (!q) { container.innerHTML = ''; return; }

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: 'Bearer ' + token } });
  const results = await res.json();

  container.innerHTML = '';
  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No results found';
    container.appendChild(empty);
    return;
  }

  results.forEach(r => {
    const div = document.createElement('div');
    div.className = 'search-result';

    const meta = document.createElement('div');
    meta.className = 'search-result-meta';
    meta.textContent = `#${r.room}  •  ${r.username}  •  ${new Date(r.timestamp).toLocaleString()}`;

    const text = document.createElement('div');
    text.className = 'search-result-text';
    text.innerHTML = highlightMatch(r.text, q);

    div.appendChild(meta);
    div.appendChild(text);
    div.addEventListener('click', () => jumpToMessage(r.room, r.messageId));
    container.appendChild(div);
  });
}, 300));

function highlightMatch(text, query) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return escapeHtml(before) + '<strong>' + escapeHtml(match) + '</strong>' + escapeHtml(after);
}

async function jumpToMessage(room, messageId) {
  closeSearch();
  if (room !== currentRoom) {
    currentRoom = room;
    document.getElementById('room-name').textContent = '#' + room;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'join_room', room }));
    await loadMessages();
    await loadRooms();
  }
  const el = document.querySelector(`.message[data-id="${messageId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 2000);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── Boot ────────────────────────────────────────────────────────────────────
init();
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "refactor: extract client-side JS to public/app.js (includes edit, delete, reactions, search)"
```

---

### Task 8: Create `server.js` and wire everything together

**Files:**
- Create: `server.js`
- Modify: `package.json`

- [ ] **Step 1: Create `server.js`**

```javascript
// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadData } from './data.js';
import { createRouter } from './routes.js';
import { setupWebSocket } from './websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 65536 });

const PORT = process.env.PORT || 3000;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled to allow CDN emoji picker
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api', createRouter());

setupWebSocket(wss);

await loadData();

server.listen(PORT, () => {
  console.log(`Alpine Team Chat running on http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Update `package.json` scripts to use `server.js`**

Replace the `"scripts"` section:
```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js"
},
```

- [ ] **Step 3: Commit**

```bash
git add server.js package.json
git commit -m "refactor: add server.js entry point, update package.json scripts"
```

---

### Task 9: Remove old file and verify the refactor works

**Files:**
- Delete: `team-chat-app.js`

- [ ] **Step 1: Delete the old monolithic file**

```bash
rm team-chat-app.js
```

- [ ] **Step 2: Start the app and verify it runs**

```bash
npm start
```

Expected output:
```
Alpine Team Chat running on http://localhost:3000
```

- [ ] **Step 3: Smoke test the API**

```bash
# Should return 401 (unauthed)
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/rooms

# Register a test user
curl -s -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@alpinekansascity.com","password":"testpass1"}' | python3 -m json.tool

# Should return 200 with rooms
TOKEN=$(curl -s -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"smoketest","email":"smoketest@alpinekansascity.com","password":"testpass1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3000/api/rooms -H "Authorization: Bearer $TOKEN"
```

Expected: 401, then a JSON user object, then `[{"name":"general",...}]`

- [ ] **Step 4: Open browser and verify full UI works**

Open http://localhost:3000 — confirm login, register, send a message, switch rooms all work.

Kill the server (`Ctrl+C`), clean up test data:
```bash
rm -f data/users.json data/messages.json
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove team-chat-app.js, refactor complete"
```

---

## Phase 2: Deploy and Verify Refactor on Production

### Task 10: Deploy refactored app

- [ ] **Step 1: Deploy to Railway**

```bash
railway up --service observant-caring
```

- [ ] **Step 2: Verify production is healthy**

```bash
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/
# Expected: 200

curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/api/rooms
# Expected: 401
```

- [ ] **Step 3: Open https://chat.alpinekansascity.com in browser, register an account, send a message — confirm everything works before proceeding to features**

---

## Phase 3: Message Editing & Deletion — Verification

The WebSocket handlers for `edit_message` and `delete_message` were already added in `websocket.js` (Task 3). This phase verifies the client UI works end-to-end.

### Task 11: Verify edit and delete in browser

- [ ] **Step 1: Open the app in two browser windows, register two accounts**

- [ ] **Step 2: Send a message from Account A. Hover over it — confirm ✏️ and 🗑️ icons appear**

- [ ] **Step 3: Click ✏️ — confirm the text becomes an editable field. Edit the text and press Enter. Confirm the edit appears in both windows with "(edited HH:MM:SS)" label**

- [ ] **Step 4: Click 🗑️ — confirm dialog appears. Confirm deletion. Verify message shows "This message was deleted" in grey italic in both windows**

- [ ] **Step 5: Switch to Account B. Hover over Account A's message — confirm no ✏️ or 🗑️ appear**

---

## Phase 4: Emoji Reactions — Verification

The `react` WebSocket handler was already added in `websocket.js` (Task 3). This phase verifies the emoji picker UI.

### Task 12: Verify reactions in browser

- [ ] **Step 1: Hover over a message — confirm 😊 button appears**

- [ ] **Step 2: Click 😊 — confirm emoji picker opens**

- [ ] **Step 3: Select an emoji — confirm it appears as a reaction pill below the message in both browser windows**

- [ ] **Step 4: Click the reaction pill — confirm your reaction is removed (toggled off)**

- [ ] **Step 5: From Account B, click the same emoji on the same message — confirm both users' reactions stack (count shows 2)**

- [ ] **Step 6: Click elsewhere on the page — confirm emoji picker closes**

---

## Phase 5: Global Search — Verification

The `/api/search` route was already added in `routes.js` (Task 4). This phase verifies the search UI.

### Task 13: Verify search in browser

- [ ] **Step 1: Send several messages across different rooms**

- [ ] **Step 2: Click the 🔍 button in the sidebar header — confirm search panel opens**

- [ ] **Step 3: Type a search term — confirm results appear with matched term bolded**

- [ ] **Step 4: Confirm results show room name, username, and timestamp**

- [ ] **Step 5: Click a result from a different room — confirm it switches to that room and highlights the message with a yellow background that fades after 2 seconds**

- [ ] **Step 6: Press Escape or click ✕ — confirm search closes and current room view returns**

- [ ] **Step 7: Search for a term in deleted messages — confirm they do not appear in results**

---

## Phase 6: Final Deploy

### Task 14: Commit and deploy

- [ ] **Step 1: Ensure all files are committed**

```bash
git status
# Should show nothing to commit
```

- [ ] **Step 2: Deploy to production**

```bash
railway up --service observant-caring
```

- [ ] **Step 3: Final production verification**

```bash
curl -s -o /dev/null -w "%{http_code}" https://chat.alpinekansascity.com/
# Expected: 200

curl -s https://chat.alpinekansascity.com/ | grep -o '<title>.*</title>'
# Expected: <title>Alpine Team Chat</title>
```

- [ ] **Step 4: Open https://chat.alpinekansascity.com — do a full end-to-end test: register, send message, edit it, delete another, react, search**

---

## Self-Review Checklist

- [x] Spec: modular refactor → Tasks 1–9
- [x] Spec: message editing → websocket.js Task 3, client Task 7, verification Task 11
- [x] Spec: message deletion → websocket.js Task 3, client Task 7, verification Task 11
- [x] Spec: reactions with toggle → websocket.js Task 3, client Task 7, verification Task 12
- [x] Spec: emoji-picker-element → imported from CDN in app.js Task 7
- [x] Spec: global search endpoint → routes.js Task 4
- [x] Spec: search UI with bolded highlight → app.js Task 7
- [x] Spec: jump to message with yellow fade → app.js `jumpToMessage`, style.css `.highlight`
- [x] Spec: XSS-safe search bolding → `highlightMatch` uses `escapeHtml` on all parts
- [x] Spec: deleted messages excluded from search → `!m.deleted` filter in routes.js
- [x] Spec: persist reactions, editedAt, deleted → all fields written to messages.json via `persistData()`
- [x] Type consistency: `broadcastRooms()` exported from websocket.js, imported in routes.js ✓
- [x] Type consistency: `store.activeConnections` used in websocket.js broadcastToRoom ✓
- [x] `helmet({ contentSecurityPolicy: false })` noted — needed for CDN emoji picker ✓

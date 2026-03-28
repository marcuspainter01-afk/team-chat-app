import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 65536 });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MAX_MESSAGES_PER_ROOM = 1000;

// Ensure data directory exists
await fs.mkdir(DATA_DIR, { recursive: true });

// In-memory store (persists to disk)
let users = {};
let messages = [];
let rooms = { general: { name: 'general', createdAt: new Date() } };
const activeConnections = new Map();

// O(1) token → username index (rebuilt on load, updated on login/register)
const tokenIndex = new Map();

// Load persisted data on startup
async function loadData() {
  try {
    const usersFile = path.join(DATA_DIR, 'users.json');
    const messagesFile = path.join(DATA_DIR, 'messages.json');
    const roomsFile = path.join(DATA_DIR, 'rooms.json');

    if (await fileExists(usersFile)) {
      users = JSON.parse(await fs.readFile(usersFile, 'utf-8'));
    }
    if (await fileExists(messagesFile)) {
      messages = JSON.parse(await fs.readFile(messagesFile, 'utf-8'));
    }
    if (await fileExists(roomsFile)) {
      rooms = JSON.parse(await fs.readFile(roomsFile, 'utf-8'));
    }

    // Rebuild token index from loaded users
    tokenIndex.clear();
    for (const [username, user] of Object.entries(users)) {
      if (user.token) tokenIndex.set(user.token, username);
    }
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function persistData() {
  try {
    await fs.writeFile(path.join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'messages.json'), JSON.stringify(messages, null, 2));
    await fs.writeFile(path.join(DATA_DIR, 'rooms.json'), JSON.stringify(rooms, null, 2));
  } catch (err) {
    console.error('Error persisting data:', err);
  }
}

const BCRYPT_ROUNDS = 12;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

function lookupToken(token) {
  const username = tokenIndex.get(token);
  if (!username) return null;
  const user = users[username];
  if (!user) return null;
  if (Date.now() - (user.tokenCreatedAt || 0) > TOKEN_TTL_MS) return null;
  return user;
}

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !lookupToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.static('public'));
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// API Routes

// Register
app.post('/api/register', async (req, res) => {
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

  if (users[username]) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const userId = crypto.randomBytes(8).toString('hex');
  const token = generateToken();

  users[username] = {
    id: userId,
    username,
    email: email.toLowerCase(),
    password: await hashPassword(password),
    token,
    tokenCreatedAt: Date.now(),
    createdAt: new Date(),
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random`
  };

  tokenIndex.set(token, username);
  await persistData();

  res.json({ token, userId, username, avatar: users[username].avatar });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = users[username];

  if (!user || !(await verifyPassword(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken();
  if (user.token) tokenIndex.delete(user.token);
  user.token = token;
  user.tokenCreatedAt = Date.now();
  tokenIndex.set(token, username);
  await persistData();

  res.json({ token, userId: user.id, username, avatar: user.avatar });
});

// Verify token
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  const user = lookupToken(token);
  if (!user) return res.status(401).json({ valid: false });
  res.json({ valid: true, userId: user.id, username: user.username, avatar: user.avatar });
});

// Get messages for a room (auth required)
app.get('/api/messages/:room', requireAuth, (req, res) => {
  const { room } = req.params;
  const roomMessages = messages.filter(m => m.room === room);
  res.json(roomMessages);
});

// Get all rooms (auth required)
app.get('/api/rooms', requireAuth, (req, res) => {
  res.json(Object.values(rooms));
});

// Create room
app.post('/api/rooms', async (req, res) => {
  const { name, token } = req.body;

  if (!name || !token) {
    return res.status(400).json({ error: 'Name and token required' });
  }

  if (!lookupToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!/^[a-zA-Z0-9-]{1,30}$/.test(name)) {
    return res.status(400).json({ error: 'Room name must be 1-30 characters, letters, numbers and hyphens only' });
  }

  if (rooms[name]) {
    return res.status(409).json({ error: 'Room already exists' });
  }

  rooms[name] = { name, createdAt: new Date() };

  await persistData();
  broadcastRooms();

  res.json(rooms[name]);
});

// WebSocket
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
          activeConnections.set(ws, { userId, username, currentRoom });
          broadcastUserStatus();
          ws.send(JSON.stringify({ type: 'auth_success', userId, username }));
          break;
        }

        case 'join_room':
          if (!userId) return;
          currentRoom = msg.room;
          activeConnections.set(ws, { userId, username, currentRoom });
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
            avatar: users[username]?.avatar,
            timestamp: new Date().toISOString()
          };

          messages.push(chatMessage);

          // Cap total messages per room to avoid unbounded growth
          const roomCount = messages.filter(m => m.room === currentRoom).length;
          if (roomCount > MAX_MESSAGES_PER_ROOM) {
            messages = messages.filter(m => m.room !== currentRoom)
              .concat(messages.filter(m => m.room === currentRoom).slice(-MAX_MESSAGES_PER_ROOM));
          }

          await persistData();

          broadcast({ type: 'message', ...chatMessage });
          break;
        }

        case 'typing':
          if (!userId) return;
          broadcastToRoom(currentRoom, { type: 'typing', username, room: currentRoom });
          break;
      }
    } catch (err) {
      console.error('WebSocket error:', err);
    }
  });

  ws.on('close', () => {
    activeConnections.delete(ws);
    broadcastUserStatus();
  });
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

function broadcastToRoom(room, msg) {
  const payload = JSON.stringify(msg);
  for (const [client, info] of activeConnections) {
    if (info.currentRoom === room && client.readyState === 1) {
      client.send(payload);
    }
  }
}

function broadcastRooms() {
  const roomsList = Object.values(rooms);
  broadcast({ type: 'rooms_updated', rooms: roomsList });
}

function broadcastUserStatus() {
  const onlineUsers = Array.from(activeConnections.values());
  broadcast({ type: 'users_online', users: onlineUsers });
}

// Serve HTML
app.get('/', (req, res) => {
  res.send(getHTML());
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alpine Team Chat</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      height: 100vh;
      overflow: hidden;
    }

    .container {
      display: flex;
      height: 100vh;
    }

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
    }

    .sidebar-header h1 {
      font-size: 18px;
      font-weight: 600;
    }

    .rooms-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
    }

    .room-item {
      padding: 10px 15px;
      margin: 5px 0;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
      font-size: 14px;
    }

    .room-item:hover {
      background: #2a2f3a;
    }

    .room-item.active {
      background: #4a9eff;
      font-weight: 600;
    }

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

    .new-room-btn:hover {
      background: #357abd;
    }

    .sidebar-footer {
      padding: 15px;
      border-top: 1px solid #2a2f3a;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #4a9eff;
    }

    .user-info {
      flex: 1;
      min-width: 0;
    }

    .user-info p {
      font-size: 13px;
      color: #aaa;
    }

    .user-info strong {
      display: block;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .logout-btn {
      background: none;
      border: none;
      color: #999;
      cursor: pointer;
      font-size: 16px;
    }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: white;
    }

    .chat-header {
      padding: 20px;
      background: white;
      border-bottom: 1px solid #e5e5e5;
    }

    .chat-header h2 {
      font-size: 18px;
      color: #1a1d26;
    }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .message {
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    }

    .message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .message-body {
      flex: 1;
    }

    .message-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .message-author {
      font-weight: 600;
      font-size: 14px;
      color: #1a1d26;
    }

    .message-time {
      font-size: 12px;
      color: #999;
    }

    .message-text {
      color: #1a1d26;
      line-height: 1.4;
      word-wrap: break-word;
    }

    .typing-indicator {
      color: #999;
      font-size: 12px;
      font-style: italic;
      padding: 5px 0;
    }

    .input-area {
      padding: 20px;
      border-top: 1px solid #e5e5e5;
      background: white;
    }

    .input-form {
      display: flex;
      gap: 10px;
    }

    .input-form input {
      flex: 1;
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
    }

    .input-form input:focus {
      outline: none;
      border-color: #4a9eff;
      box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.1);
    }

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

    .input-form button:hover {
      background: #357abd;
    }

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

    .auth-box h1 {
      margin-bottom: 30px;
      color: #1a1d26;
      text-align: center;
    }

    .auth-form {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .auth-form input {
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
    }

    .auth-form input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

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

    .auth-form button:hover {
      background: #5568d3;
    }

    .auth-toggle {
      text-align: center;
      font-size: 13px;
      color: #666;
      margin-top: 15px;
    }

    .auth-toggle a {
      color: #667eea;
      cursor: pointer;
      text-decoration: underline;
    }

    .error {
      padding: 12px;
      background: #fee;
      color: #c33;
      border-radius: 6px;
      font-size: 13px;
    }

    .hidden {
      display: none;
    }

    .scrollable {
      overflow-y: auto;
    }

    .scrollable::-webkit-scrollbar {
      width: 6px;
    }

    .scrollable::-webkit-scrollbar-track {
      background: transparent;
    }

    .scrollable::-webkit-scrollbar-thumb {
      background: #ddd;
      border-radius: 3px;
    }

    .scrollable::-webkit-scrollbar-thumb:hover {
      background: #bbb;
    }
  </style>
</head>
<body>
  <div id="auth-screen" class="auth-container">
    <div class="auth-box">
      <h1>Alpine Team Chat</h1>
      <div id="login-form" class="auth-form">
        <input type="text" id="login-username" placeholder="Username" />
        <input type="password" id="login-password" placeholder="Password" />
        <button onclick="handleLogin()">Sign In</button>
        <div class="auth-toggle">
          Don't have an account? <a onclick="toggleAuthForm()">Sign Up</a>
        </div>
        <div id="auth-error" class="error hidden"></div>
      </div>
      <div id="register-form" class="auth-form hidden">
        <input type="text" id="register-username" placeholder="Choose a username" />
        <input type="email" id="register-email" placeholder="your@alpinekansascity.com" />
        <input type="password" id="register-password" placeholder="Choose a password" />
        <input type="password" id="register-confirm" placeholder="Confirm password" />
        <button onclick="handleRegister()">Create Account</button>
        <div class="auth-toggle">
          Already have an account? <a onclick="toggleAuthForm()">Sign In</a>
        </div>
        <div id="auth-error-reg" class="error hidden"></div>
      </div>
    </div>
  </div>

  <div id="chat-screen" class="container hidden">
    <div class="sidebar scrollable">
      <div class="sidebar-header">
        <h1>Alpine Team Chat</h1>
      </div>
      <div class="rooms-list" id="rooms-list"></div>
      <button class="new-room-btn" onclick="promptNewRoom()">+ New Room</button>
      <div class="sidebar-footer">
        <img id="user-avatar" class="user-avatar" />
        <div class="user-info">
          <strong id="username-display"></strong>
          <p>Online</p>
        </div>
        <button class="logout-btn" onclick="handleLogout()">✕</button>
      </div>
    </div>

    <div class="main-content">
      <div class="chat-header">
        <h2 id="room-name"></h2>
      </div>
      <div class="messages-container scrollable" id="messages"></div>
      <div class="input-area">
        <form class="input-form" onsubmit="sendMessage(event)">
          <input
            type="text"
            id="message-input"
            placeholder="Type a message..."
            autocomplete="off"
          />
          <button type="submit">Send</button>
        </form>
      </div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('token');
    let userId = null;
    let username = null;
    let currentRoom = 'general';
    let ws = null;

    async function init() {
      try {
        if (token) {
          const res = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });

          const data = await res.json();

          if (data.valid) {
            userId = data.userId;
            username = data.username;
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

    function toggleAuthForm() {
      document.getElementById('login-form').classList.toggle('hidden');
      document.getElementById('register-form').classList.toggle('hidden');
      clearAuthErrors();
    }

    async function handleLogin() {
      const u = document.getElementById('login-username').value;
      const p = document.getElementById('login-password').value;
      const err = document.getElementById('auth-error');

      if (!u || !p) {
        err.textContent = 'Username and password required';
        err.classList.remove('hidden');
        return;
      }

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });

      const data = await res.json();

      if (!res.ok) {
        err.textContent = data.error;
        err.classList.remove('hidden');
        return;
      }

      token = data.token;
      userId = data.userId;
      username = data.username;
      localStorage.setItem('token', token);
      showChat();
      connectWebSocket();
      loadRooms();
      loadMessages();
    }

    async function handleRegister() {
      const u = document.getElementById('register-username').value;
      const e = document.getElementById('register-email').value;
      const p = document.getElementById('register-password').value;
      const c = document.getElementById('register-confirm').value;
      const err = document.getElementById('auth-error-reg');

      if (!u || !e || !p || !c) {
        err.textContent = 'All fields required';
        err.classList.remove('hidden');
        return;
      }

      if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) {
        err.textContent = 'Username must be 3-30 characters, letters, numbers and underscores only';
        err.classList.remove('hidden');
        return;
      }

      if (!e.toLowerCase().endsWith('@alpinekansascity.com')) {
        err.textContent = 'Must use an @alpinekansascity.com email address';
        err.classList.remove('hidden');
        return;
      }

      if (p.length < 8) {
        err.textContent = 'Password must be at least 8 characters';
        err.classList.remove('hidden');
        return;
      }

      if (p !== c) {
        err.textContent = 'Passwords do not match';
        err.classList.remove('hidden');
        return;
      }

      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, email: e, password: p })
      });

      const data = await res.json();

      if (!res.ok) {
        err.textContent = data.error;
        err.classList.remove('hidden');
        return;
      }

      token = data.token;
      userId = data.userId;
      username = data.username;
      localStorage.setItem('token', token);
      showChat();
      connectWebSocket();
      loadRooms();
      loadMessages();
    }

    function handleLogout() {
      localStorage.removeItem('token');
      token = null;
      if (ws) ws.close();
      showAuth();
    }

    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
        ws.send(JSON.stringify({ type: 'join_room', room: currentRoom }));
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === 'message' && msg.room === currentRoom) {
          displayMessage(msg);
        } else if (msg.type === 'rooms_updated') {
          renderRooms(msg.rooms);
        }
      };
    }

    async function loadRooms() {
      const res = await fetch('/api/rooms', { headers: { 'Authorization': 'Bearer ' + token } });
      const rooms = await res.json();
      renderRooms(rooms);
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
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'join_room', room }));
      }
      loadMessages();
    }

    async function loadMessages() {
      const res = await fetch(\`/api/messages/\${currentRoom}\`, { headers: { 'Authorization': 'Bearer ' + token } });
      const msgs = await res.json();
      const container = document.getElementById('messages');
      container.innerHTML = '';
      msgs.forEach(displayMessage);
      container.scrollTop = container.scrollHeight;
    }

    function displayMessage(msg) {
      const container = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'message';

      const avatar = document.createElement('img');
      avatar.src = msg.avatar || '';
      avatar.className = 'message-avatar';

      const body = document.createElement('div');
      body.className = 'message-body';

      const header = document.createElement('div');
      header.className = 'message-header';

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = msg.username;

      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = new Date(msg.timestamp).toLocaleTimeString();

      const text = document.createElement('div');
      text.className = 'message-text';
      text.textContent = msg.text;

      header.appendChild(author);
      header.appendChild(time);
      body.appendChild(header);
      body.appendChild(text);
      div.appendChild(avatar);
      div.appendChild(body);
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function sendMessage(e) {
      e.preventDefault();
      const input = document.getElementById('message-input');
      const text = input.value.trim();

      if (!text || !ws || ws.readyState !== 1) return;

      ws.send(JSON.stringify({ type: 'message', text }));
      input.value = '';
    }

    async function promptNewRoom() {
      const name = prompt('Room name (no spaces or special chars):');

      if (!name) return;

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.toLowerCase().trim(), token })
      });

      if (!res.ok) {
        const err = await res.json();
        alert('Error: ' + err.error);
        return;
      }

      loadRooms();
    }

    function clearAuthErrors() {
      document.getElementById('auth-error').classList.add('hidden');
      document.getElementById('auth-error-reg').classList.add('hidden');
    }

    function escapeHtml(text) {
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      };
      return text.replace(/[&<>"']/g, m => map[m]);
    }

    init();
  </script>
</body>
</html>`;
}

await loadData();

server.listen(PORT, () => {
  console.log(`Alpine Team Chat running on http://localhost:${PORT}`);
});

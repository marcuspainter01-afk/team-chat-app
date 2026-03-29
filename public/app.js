// public/app.js
import 'https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js';

let token = localStorage.getItem('token');
let userId = null;
let username = null;
let currentRoom = 'general';
let ws = null;
let activeEmojiPicker = null; // track open picker to close on outside click
let pushSubscription = null;
let subscribedRooms = new Set(JSON.parse(localStorage.getItem('push-rooms') || '[]'));
let pushInitialized = false;

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
        initPush();
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
  initPush();
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
  initPush();
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

    const label = document.createElement('span');
    label.textContent = '# ' + r.name;
    div.appendChild(label);

    const bell = document.createElement('button');
    bell.className = 'room-bell-btn' + (subscribedRooms.has(r.name) ? ' active' : '');
    bell.textContent = '🔔';
    bell.title = subscribedRooms.has(r.name) ? 'Mute notifications' : 'Enable notifications';
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRoomBell(r.name, bell);
    });
    div.appendChild(bell);

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

// ─── Push Notifications ──────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (pushInitialized) return;
  pushInitialized = true;

  // iOS install banner
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (isIos && !isStandalone && !localStorage.getItem('ios-banner-dismissed')) {
    showIosBanner();
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const existing = await reg.pushManager.getSubscription();
    if (existing) pushSubscription = existing;

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'navigate_room' && event.data.room) {
        switchRoom(event.data.room);
      }
    });
  } catch (err) {
    console.warn('Service worker registration failed:', err);
  }
}

function showIosBanner() {
  const banner = document.createElement('div');
  banner.className = 'ios-banner';
  const text = document.createElement('span');
  text.textContent = "To enable notifications on iOS, tap the Share button and choose 'Add to Home Screen', then reopen the app.";
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ios-banner-close';
  closeBtn.title = 'Dismiss';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    localStorage.setItem('ios-banner-dismissed', '1');
    banner.remove();
  });
  banner.appendChild(text);
  banner.appendChild(closeBtn);
  document.body.appendChild(banner);
}

async function toggleRoomBell(room, bellBtn) {
  if (Notification.permission === 'denied') {
    showBellError(bellBtn, 'Notifications blocked — check your browser settings');
    return;
  }

  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      showBellError(bellBtn, 'Notifications blocked — check your browser settings');
      return;
    }
  }

  if (!pushSubscription) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch('/api/push/vapid-public-key', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!keyRes.ok) throw new Error('VAPID key fetch failed: ' + keyRes.status);
      const { publicKey } = await keyRes.json();
      pushSubscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      subscribedRooms.add(room);
      localStorage.setItem('push-rooms', JSON.stringify([...subscribedRooms]));
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ subscription: pushSubscription.toJSON(), rooms: [...subscribedRooms] })
      });
    } catch (err) {
      console.warn('Push subscription failed:', err);
      return;
    }
  } else {
    const wasSubscribed = subscribedRooms.has(room);
    if (wasSubscribed) {
      subscribedRooms.delete(room);
    } else {
      subscribedRooms.add(room);
    }
    localStorage.setItem('push-rooms', JSON.stringify([...subscribedRooms]));
    try {
      const res = await fetch('/api/push/rooms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ endpoint: pushSubscription.endpoint, rooms: [...subscribedRooms] })
      });
      if (!res.ok) throw new Error('Room update failed: ' + res.status);
    } catch (err) {
      // Revert state on failure
      if (wasSubscribed) {
        subscribedRooms.add(room);
      } else {
        subscribedRooms.delete(room);
      }
      localStorage.setItem('push-rooms', JSON.stringify([...subscribedRooms]));
      console.warn('Failed to update push rooms:', err);
      return;
    }
  }

  bellBtn.classList.toggle('active', subscribedRooms.has(room));
  bellBtn.title = subscribedRooms.has(room) ? 'Mute notifications' : 'Enable notifications';
}

function showBellError(bellBtn, msg) {
  document.querySelectorAll('.bell-error').forEach(el => el.remove());
  const err = document.createElement('div');
  err.className = 'bell-error';
  err.textContent = msg;
  err.style.cssText = 'position:fixed;background:#fee;color:#c33;border-radius:6px;padding:6px 10px;font-size:12px;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.15)';
  const rect = bellBtn.getBoundingClientRect();
  err.style.top = (rect.bottom + 4) + 'px';
  err.style.left = rect.left + 'px';
  document.body.appendChild(err);
  setTimeout(() => err.remove(), 4000);
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

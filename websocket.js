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

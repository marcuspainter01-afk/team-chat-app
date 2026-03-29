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
  pushSubscriptions: {},
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

    const pushFile = path.join(DATA_DIR, 'push.json');
    if (await fileExists(pushFile)) {
      store.pushSubscriptions = JSON.parse(await fs.readFile(pushFile, 'utf-8'));
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
    await fs.writeFile(path.join(DATA_DIR, 'push.json'), JSON.stringify(store.pushSubscriptions, null, 2));
  } catch (err) {
    console.error('Error persisting data:', err);
    throw err;
  }
}

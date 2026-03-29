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
  const user = token ? lookupToken(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}

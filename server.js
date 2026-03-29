// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadData } from './data.js';
import { initVapid } from './push.js';
import { createRouter } from './routes.js';
import { setupWebSocket } from './websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // Required for express-rate-limit behind Railway's proxy
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

initVapid();
await loadData();

server.listen(PORT, () => {
  console.log(`Alpine Team Chat running on http://localhost:${PORT}`);
});

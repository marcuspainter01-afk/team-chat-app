# Push Notifications Design

**Goal:** Add Web Push notifications to Alpine Team Chat so users get notified on their phones when new messages arrive in rooms they've opted into.

**Architecture:** Web Push API with VAPID keys, a PWA manifest + service worker for installability, per-room subscription preferences stored alongside each push subscription on the server.

**Tech Stack:** `web-push` npm package, Web Push API, Service Worker API, PWA manifest

---

## Components

### New Files

| File | Purpose |
|------|---------|
| `public/manifest.json` | PWA manifest — enables "Add to Home Screen" on iOS/Android |
| `public/sw.js` | Service worker — handles `push` events and `notificationclick` |
| `push.js` | Server module — VAPID key management, subscription storage, send notifications |

### Modified Files

| File | Changes |
|------|---------|
| `data.js` | Add `pushSubscriptions: {}` to store; persist to `data/push.json` |
| `routes.js` | Add 3 push endpoints |
| `websocket.js` | Call `sendRoomPush()` after a new message is saved |
| `public/index.html` | Add `<link rel="manifest">` tag |
| `public/app.js` | Register SW, bell icon logic, permission flow, iOS banner |
| `public/style.css` | Bell icon styles |

---

## Data Model

Push subscriptions are stored in `store.pushSubscriptions`, keyed by userId. Each user can have multiple device subscriptions (e.g., phone + tablet), each with its own room preferences.

```javascript
store.pushSubscriptions = {
  [userId]: [
    {
      subscription: {
        endpoint: "https://fcm.googleapis.com/...",
        expirationTime: null,
        keys: { p256dh: "...", auth: "..." }
      },
      rooms: ["general", "contracts", "listings"]
    }
  ]
}
```

Persisted to `data/push.json`. Expired subscriptions (server receives HTTP 410 from push service) are pruned automatically on send.

---

## Server: `push.js`

Exports:
- `initVapid()` — loads VAPID keys from `process.env.VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; throws on startup if missing
- `getVapidPublicKey()` — returns the public key string for the client
- `sendRoomPush(room)` — finds all subscriptions opted into `room`, skips users currently connected via WebSocket, sends push notification to each, prunes expired subscriptions
- Notification payload: `{ title: "Alpine Team Chat", body: "New message in #<room>", icon: "/icon-192.png", badge: "/icon-192.png", data: { room } }`

VAPID contact email: `process.env.VAPID_CONTACT_EMAIL` (e.g. `mailto:admin@alpinekansascity.com`)

---

## API Routes (added to `routes.js`)

All three require `requireAuth`.

### `GET /api/push/vapid-public-key`
Returns `{ publicKey: "..." }`. Called by the client before creating a push subscription.

### `POST /api/push/subscribe`
Body: `{ subscription: {...}, rooms: ["general"] }`
Stores the subscription under the authenticated user's userId. If the same endpoint already exists, replaces it (handles re-registration). Returns `204`.

### `PUT /api/push/rooms`
Body: `{ endpoint: "...", rooms: ["general", "contracts"] }`
Updates the rooms array for the matching subscription endpoint. Returns `204` or `404` if endpoint not found.

---

## Service Worker: `public/sw.js`

**`push` event handler:**
1. Parse `event.data.json()` to get `{ title, body, icon, badge, data }`
2. Call `self.registration.showNotification(title, { body, icon, badge, data, tag: data.room })`
3. `tag: data.room` collapses multiple notifications from the same room into one

**`notificationclick` event handler:**
1. `event.notification.close()`
2. Open or focus `chat.alpinekansascity.com` (check existing windows first via `clients.matchAll`)
3. Pass `data.room` via `postMessage` so the app can switch to the correct room on open

---

## Client: Bell Icon UI (`public/app.js`)

### Rendering
Each room item in the sidebar gets a `🔔` button. When the user is subscribed to that room, it shows as active (filled style); when not, it shows dimmed.

### First-time flow
1. User taps 🔔 on a room
2. If `Notification.permission === 'default'` → call `Notification.requestPermission()`
3. If denied → show inline error "Notifications blocked — check your browser settings"
4. If granted → register service worker → get push subscription via `pushManager.subscribe()`
5. POST subscription + `[room]` to `/api/push/subscribe`

### Toggling a room
- If already subscribed: PUT `/api/push/rooms` with updated rooms array (room removed)
- If not subscribed: PUT `/api/push/rooms` with updated rooms array (room added)
- Update bell icon state immediately in UI

### iOS banner
On page load, detect iOS (`/iPhone|iPad|iPod/.test(navigator.userAgent)`) and check if NOT in standalone mode (`window.navigator.standalone !== true`). If both true, show a one-time dismissible banner:
> "To enable notifications on iOS, tap the Share button and choose 'Add to Home Screen', then reopen the app."

Banner is dismissed permanently via `localStorage.setItem('ios-banner-dismissed', '1')`.

---

## PWA Manifest: `public/manifest.json`

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

Icons: two simple PNG files generated as solid `#4a9eff` squares with "AC" text — no external dependencies.

---

## Environment Variables

Two new variables required in `.env` and Railway dashboard:

```
VAPID_PUBLIC_KEY=<generated>
VAPID_PRIVATE_KEY=<generated>
VAPID_CONTACT_EMAIL=admin@alpinekansascity.com
```

Generated once with `web-push generate-vapid-keys`. Committed to `.env.example` as placeholders (not real values).

---

## Notification Behavior

- **Content:** `"New message in #room-name"` — no message text, no sender name (privacy)
- **Deduplication:** `tag: room` means multiple rapid messages in the same room collapse to a single notification
- **Active users skipped:** users with an active WebSocket connection are not pushed (they see messages in real time)
- **Expired subscriptions pruned:** HTTP 410 response from push service triggers automatic removal
- **iOS requirement:** must be added to home screen via Safari for push to work (iOS 16.4+)

---

## Notification Permission States

| State | Behavior |
|-------|---------|
| `default` | Bell tap triggers permission prompt |
| `granted` | Bell tap subscribes/unsubscribes directly |
| `denied` | Bell tap shows inline error message |

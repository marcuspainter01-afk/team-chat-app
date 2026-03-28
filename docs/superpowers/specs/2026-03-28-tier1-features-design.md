# Alpine Team Chat — Tier 1 Features Design

**Date:** 2026-03-28
**Status:** Approved
**Scope:** Modular refactor + message editing/deletion, emoji reactions, global message search

---

## Context

The app currently lives in a single `team-chat-app.js` file (~1,070 lines). Adding Tier 1 features would push it to ~1,500+ lines, making it hard to maintain. This spec covers a modular refactor alongside three new features. Tier 2 and Tier 3 features will be specced separately after Tier 1 ships.

---

## 1. File Structure Refactor

Split `team-chat-app.js` into focused modules. No logic changes — purely reorganization.

```
team-chat-app/
├── server.js          # Entry point — HTTP server, wires everything together
├── routes.js          # All Express API routes
├── websocket.js       # All WebSocket message handling
├── data.js            # In-memory store, load/persist to disk, token index
├── auth.js            # Token lookup, requireAuth middleware, bcrypt helpers
├── public/
│   ├── index.html     # HTML shell
│   ├── app.js         # All client-side JavaScript
│   └── style.css      # Styles
├── package.json
└── .gitignore
```

Each file must stay under 500 lines.

---

## 2. Message Editing & Deletion

### Rules
- Users may only edit or delete their own messages
- No time limit on editing or deletion
- Deleted messages are soft-deleted (not removed) so history stays intact

### Server
- New WebSocket message types:
  - `edit_message`: `{ messageId, text }` — validates ownership, updates text, sets `editedAt`
  - `delete_message`: `{ messageId }` — validates ownership, sets `deleted: true`, clears `text`
- Both broadcast to all clients in the room after applying the change
- Broadcast types: `message_edited`, `message_deleted`

### Data Shape

Edited message:
```json
{
  "id": "abc123",
  "text": "corrected text",
  "editedAt": "2026-03-28T20:00:00.000Z"
}
```

Deleted message:
```json
{
  "id": "abc123",
  "deleted": true,
  "text": ""
}
```

### Client
- Hovering over own messages reveals ✏️ (edit) and 🗑️ (delete) icons
- **Edit:** message text becomes an inline editable field; saves on Enter, cancels on Escape
- **Delete:** single confirmation prompt; message renders as *"This message was deleted"* in grey italic
- Edited messages show a `(edited)` label with the `editedAt` timestamp

---

## 3. Emoji Reactions

### Library
`emoji-picker-element` — 50KB, no dependencies, native emoji, full picker UI

### Rules
- Any user can react to any message (including others' messages)
- Reacting with the same emoji a second time removes the reaction (toggle)
- Multiple different emoji per user per message is allowed

### Server
- New WebSocket message type: `react` — `{ messageId, emoji }`
- Reactions stored on messages as `{ [emoji]: [userId, ...] }`
- Toggle: if userId already in the array for that emoji, remove; otherwise add
- Broadcast `reaction_updated`: `{ messageId, reactions }` to all clients in the room

### Data Shape
```json
{
  "id": "abc123",
  "text": "Let's meet at 2pm",
  "reactions": {
    "👍": ["userId1", "userId2"],
    "❤️": ["userId3"]
  }
}
```

### Client
- Hovering a message shows a 😊 button
- Clicking opens the emoji picker
- Reactions display as pills below the message: `👍 2  ❤️ 1`
- Clicking an existing pill toggles your own reaction
- Your own active reactions are highlighted in blue

---

## 4. Global Message Search

### Server
- New authenticated endpoint: `GET /api/search?q=term`
- Case-insensitive substring match across all non-deleted messages
- Results sorted newest first, capped at 50
- Response shape: `{ room, messageId, username, text, timestamp }[]`

### Client
- 🔍 icon in sidebar header opens a search input
- Results replace the chat view in the main panel
- Each result shows: room badge, username, snippet with matched term **bolded**, timestamp
  - Bolding is done by escaping the full text, then wrapping the matched substring in `<strong>` — never inject raw user content as HTML
- Clicking a result: switches to that room, loads its messages, then scrolls to and highlights (yellow background, 2s fade) the matched message by ID
- Escape or ✕ closes search and restores current room view

---

## 5. Data Persistence

- `reactions` and `editedAt` and `deleted` fields are persisted in `data/messages.json`
- `persistData()` is always awaited before responding
- No schema migration needed — fields are optional and default to absent on old messages

---

## 6. Dependencies Added

| Package | Purpose |
|---------|---------|
| `emoji-picker-element` | Full emoji picker UI for reactions |

---

## 7. Testing Checklist

- [ ] Edit own message — text updates for all connected clients
- [ ] Edit someone else's message — rejected
- [ ] Delete own message — shows "deleted" placeholder for all clients
- [ ] Delete someone else's message — rejected
- [ ] React with emoji — reaction appears for all clients
- [ ] React again with same emoji — reaction removed
- [ ] React with different emoji — both reactions show
- [ ] Search returns results across all rooms
- [ ] Search skips deleted messages
- [ ] Clicking search result navigates to correct room and message
- [ ] All features persist across server restart
- [ ] No regressions on existing auth, messaging, and room features

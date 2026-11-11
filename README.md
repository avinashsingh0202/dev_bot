# DevBot (Phase 1)

Team chat → Cursor Cloud Agents → GitHub PR, with status posted back to the same chat thread.

Stack: **Node.js 20+**, TypeScript, Express, Postgres (`pg`), zod, `tsx`.

## Setup

```bash
# 1) Start Postgres
docker compose up -d

# 2) Configure env (placeholders only in the example — fill real secrets locally)
cp .env.example .env
# edit .env: CURSOR_*, GITHUB_*, CHAT_*, PUBLIC_BASE_URL, DEFAULT_REPO, …

# 3) Install + run
npm install
npm test
npm run dev
```

Migrations in `migrations/` run automatically on startup.

## Expose with ngrok

Cursor and GitHub need a public HTTPS URL for webhooks:

```bash
ngrok http 3000
# set PUBLIC_BASE_URL=https://<your-subdomain>.ngrok-free.app in .env and restart
```

## Register webhooks

### Chat (Isometrik → DevBot)

Point Isometrik outgoing webhook / event delivery at:

`POST {PUBLIC_BASE_URL}/webhooks/chat`

Inbound mapping (`parseChatMessage()` in `src/routes/chat.ts`):

| DevBot field | Isometrik field |
|--------------|-----------------|
| `text` | `body` (fallback `notificationBody`) |
| `sender_id` | `senderId` |
| `sender_name` | `senderName` |
| `message_id` | `messageId` |
| `channel_id` | `conversationId` |
| `thread_id` | `parentMessageId` if present, else `messageId` (thread root) |

Ignores events where `senderId === BOT_USER_ID`. Starts a request only when `@devbot` appears in the body (case-insensitive). Typical `action`: `chatMessageSent`.

```json
{
  "action": "chatMessageSent",
  "messageId": "msg_123",
  "conversationId": "conv_123",
  "senderId": "U_ada",
  "senderName": "Ada",
  "body": "@devbot fix the null check in auth.ts"
}
```

**Outbound:** set `CHAT_POST_URL` to Isometrik's **send-message** API. `src/clients/chat.ts` keeps a stable `postMessage(channelId, threadId, text)` surface; auth/body shape still needs official send-message docs (see TODO there — do not invent secrets).

### Cursor (agent status → DevBot)

Configured automatically when DevBot launches an agent (`webhook.url` + `webhook.secret` = `CURSOR_WEBHOOK_SECRET`). Header: `X-Webhook-Signature`.

### GitHub (PR + workflow_run → DevBot)

On the sandbox repo → Settings → Webhooks → Add webhook:

- Payload URL: `{PUBLIC_BASE_URL}/webhooks/github`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: **Pull requests**, **Workflow runs**

## Curl: simulate an Isometrik mention

```bash
curl -sS -X POST "http://localhost:3000/webhooks/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "chatMessageSent",
    "messageId": "m1",
    "conversationId": "c1",
    "senderId": "U_ada",
    "senderName": "Ada",
    "body": "@devbot fix the flaky login test"
  }'
```

Thread commands (reply with `parentMessageId` = root `messageId`): `retry`, `stop`, `status`.

## Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| GET | `/requests/:id/timeline` | Events newest-first (Phase 2 board) |
| POST | `/webhooks/chat` | Inbound chat |
| POST | `/webhooks/cursor` | Cursor agent status (raw + HMAC) |
| POST | `/webhooks/github` | GitHub PR / CI (raw + HMAC) |

## Reuse notes

- **Chat vendor (Isometrik)**: inbound = `parseChatMessage()`; outbound = `src/clients/chat.ts` (`postMessage`). Mapping note: project `internal/isometrik-chat-mapping.md`.
- **CI retry policy**: pure helper `decideCiRetry()` in `src/clients/github.ts` (unit-tested).
- **Signature helpers**: `src/verify.ts` shared by Cursor + GitHub.
- **Agent concurrency**: `src/queue.ts` caps at 3 running agents; extras get "Queued".
- **Phase 2 board**: `requests.board_card_id` and `/requests/:id/timeline` are ready.

## Scripts

| Script | What |
|--------|------|
| `npm run dev` | Watch mode via `tsx` |
| `npm start` | Run once |
| `npm test` | Unit tests (signatures, chat parse, CI retry) |
| `npm run typecheck` | `tsc --noEmit` |

# DevBot (Phase 1)

Team chat → Cursor Cloud Agents → GitHub PR, with status posted back to the same chat thread.

Stack: **Node.js 20+**, TypeScript, Express, Postgres (`pg`), zod, `tsx`.

## Setup

```bash
# 1) Start local Postgres (compose service name: postgres → localhost:5432)
docker compose up -d

# 2) Configure env (placeholders only in the example — fill real secrets locally)
cp .env.example .env
# edit .env: CURSOR_*, GITHUB_*, CHAT_*, PUBLIC_BASE_URL, DEFAULT_REPO, …

# 3) Install + run (server loads .env via dotenv)
npm install
npm test
npm run dev
```

`docker compose up -d` starts the `postgres` service (`devbot` / `devbot` / db `devbot` on port 5432). Match that with `DATABASE_URL=postgres://devbot:devbot@localhost:5432/devbot`.

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

Ignores events where `senderId === BOT_USER_ID` (when set). Does **not** act on every message in the allowlisted conversation.

**New request trigger:** trimmed `body` must **start with** `@devbot` (case-insensitive), e.g. `@devbot test`. That prefix is stripped for the agent prompt. Mid-message `@devbot` does not start a request. Thread replies on an existing request still work without `@devbot` again. Typical `action`: `chatMessageSent`.

**POC allowlists** (env, comma-separated; empty = allow all for that dimension). Non-matches are ignored with **no reply**:

| Env | POC default |
|-----|-------------|
| `ALLOWED_USER_IDS` | `661e62abed6eab0034a910ef` |
| `ALLOWED_CONVERSATION_IDS` | `6af4f6f3e94e470001d1326e` |

```json
{
  "action": "chatMessageSent",
  "messageId": "msg_123",
  "conversationId": "6af4f6f3e94e470001d1326e",
  "senderId": "661e62abed6eab0034a910ef",
  "senderName": "Ada",
  "body": "@devbot test"
}
```

**Outbound (optional for POC):** `CHAT_POST_URL`, `CHAT_BOT_TOKEN`, and `BOT_USER_ID` may be left empty for listen/trigger testing — `postMessage` logs and skips; requests + Cursor launches still run. When ready, set `CHAT_POST_URL` to Isometrik's **send-message** API (`src/clients/chat.ts`; auth/body docs still TODO — do not invent secrets). `CURSOR_MODEL` stays optional (Cursor default when blank).

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
    "conversationId": "6af4f6f3e94e470001d1326e",
    "senderId": "661e62abed6eab0034a910ef",
    "senderName": "Ada",
    "body": "@devbot test"
  }'
```

Thread commands (reply with `parentMessageId` = root `messageId`; no `@devbot` needed): `retry`, `stop`, `status`.

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

# DevBot (Phase 1)

Team chat → Cursor Cloud Agents → GitHub PR, with status posted back to the same chat thread.

Stack: **Node.js 20+**, TypeScript, Express, Postgres (`pg`), zod, `tsx`.

## Setup

```bash
# 1) Start local Postgres (compose service name: postgres → localhost:5433)
docker compose up -d

# 2) Configure env (placeholders only in the example — fill real secrets locally)
cp .env.example .env
# edit .env: CURSOR_*, GITHUB_*, CHAT_*, PUBLIC_BASE_URL, DEFAULT_REPO, …

# 3) Install + run (server loads .env via dotenv)
npm install
npm test
npm run dev
```

`docker compose up -d` starts the `postgres` service (`devbot` / `devbot` / db `devbot` on **host** port **5433**, container 5432). Match that with `DATABASE_URL=postgres://devbot:devbot@localhost:5433/devbot`. Host `:5432` is left free for other local stacks.

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

A message that is only a greeting (`@devbot hi`, `hello`, `hey`, `good morning`) gets a short welcome with four actions — create a task or card, start a code change, check status, or get help — and does not start work.

**Related bug (same agent):** a new `@devbot` report in that conversation is sent to an open agent when it names that agent's branch or PR, shares enough distinctive words with the open report, or says "same bug" / "still broken" while only one request is open. That is a Cursor follow-up on the same branch, which avoids a second agent launch. `@devbot new …` always starts a fresh agent. If the matched agent is still running, the report waits and is sent once when that run finishes.

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

Launch sets `autoCreatePr: true`. If the FINISHED webhook includes `target.prUrl`, that URL is stored. If it includes a branch and no PR URL, DevBot opens the pull request itself (`ensurePullRequest()` in `src/clients/github.ts`) against `DEFAULT_REF`. A finish with no branch stays a clarification — the agent made no commit.

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
- **PR after a Cursor finish**: `planFinishedPullRequest()` decides record / open / clarify (unit-tested). `ensurePullRequest()` is the GitHub call — reuse it anywhere a `devbot/…` branch needs one open PR; it returns an existing open PR for that head instead of creating a second one. Needs pull-request write on `GITHUB_TOKEN`.
- **Signature helpers**: `src/verify.ts` shared by Cursor + GitHub.
- **Agent concurrency**: `src/queue.ts` caps at 3 running agents; extras get "Queued". `src/queue.ts` only launches a new agent.
- **Same agent for a related bug**: `pickRelatedRequest()` in `src/related.ts` (unit-tested; tune `MIN_SHARED_TOKENS` and `MIN_OVERLAP_SCORE` there). Delivery is `routeRelatedReport()` / `flushPendingFollowups()` in `src/followup.ts` — one follow-up for every report that was waiting. Extra chat threads are stored in `request_threads` and resolved by `findRequestByThread()`; keep using that helper. `@devbot new …` skips the match and launches.
- **Phase 2 board**: `requests.board_card_id` and `/requests/:id/timeline` are ready.

## Scripts

| Script | What |
|--------|------|
| `npm run dev` | Watch mode via `tsx` |
| `npm start` | Run once |
| `npm test` | Unit tests (signatures, chat parse, CI retry) |
| `npm run typecheck` | `tsc --noEmit` |

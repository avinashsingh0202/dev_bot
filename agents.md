# DevBot agent guide

Guidance for coding agents changing this repository. Operator setup, webhook registration, and curl examples live in `README.md`. This file records only behavior and commands that exist in the tree today.

## Project context

DevBot Phase 1 turns an Isometrik team-chat mention into a Cursor Cloud Agent run and a GitHub pull request, then posts status back to the same chat thread.

Stack: Node.js 20+ (`package.json` `engines`), TypeScript (ESM, `"type": "module"`), Express 4, Postgres via `pg`, zod, and `tsx`. There is no separate build artifact: `tsc` is typecheck-only (`noEmit: true`). The process runs TypeScript directly with `tsx`.

Runtime flow:

1. `POST /webhooks/chat` parses an Isometrik (or snake_case alias) payload. A new request must start with `@devbot`. Thread replies on an existing request do not.
2. `src/queue.ts` launches a Cursor agent (`autoCreatePr: true`) on branch `devbot/<first 8 chars of the request id>`, capped at 3 running agents.
3. `POST /webhooks/cursor` records finish, error, and PR state. If the finish webhook has a branch and no PR URL, `ensurePullRequest()` in `src/clients/github.ts` opens one against `DEFAULT_REF`.
4. `POST /webhooks/github` handles `pull_request` and `workflow_run` for branches prefixed `devbot/`. Failed CI can follow up on the same agent up to `MAX_CI_RETRIES` (default 2).

A new `@devbot` report that names an open agent's branch or PR, shares enough distinctive words with that report, or says "same bug" / "still broken" while only one request is open is a follow-up on that agent (`src/related.ts`, `src/followup.ts`). `@devbot new …` always starts a fresh agent.

`board_card_id` and `GET /requests/:id/timeline` are reserved for a Phase 2 board. Leave `board_card_id` null in Phase 1.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | Entrypoint. Loads `.env`, runs migrations, mounts routes. |
| `src/config.ts` | Only place that reads `process.env`. zod schema and `loadConfig()`. |
| `src/db.ts` | Pool, startup migrations, request/event helpers. |
| `src/queue.ts` | In-process cap of 3 running agents. Launches new agents only. |
| `src/related.ts` | Pure "same bug?" match policy and constants. |
| `src/followup.ts` | Sends or queues a related report on an existing agent. |
| `src/verify.ts` | Shared HMAC helpers for Cursor and GitHub. |
| `src/clients/chat.ts` | Outbound chat. Stable surface is `postMessage(channelId, threadId, text)`. |
| `src/clients/cursor.ts` | Cursor Cloud Agents v0 client (`https://api.cursor.com/v0`). |
| `src/clients/github.ts` | GitHub REST plus pure PR/CI decisions. |
| `src/routes/chat.ts` | Inbound chat adapter (`parseChatMessage`) and thread commands. |
| `src/routes/cursor.ts` | Cursor status webhook. |
| `src/routes/github.ts` | GitHub PR and `workflow_run` webhook. |
| `migrations/*.sql` | Schema, applied in filename order on startup. |
| `tests/*.test.ts` | Unit tests of pure helpers. No Postgres and no HTTP server. |
| `docker-compose.yml` | Local Postgres 16 only. |
| `.env.example` | Placeholder env. Copy to `.env`; never commit secrets. |

There is no `CONTRIBUTING.md`, ESLint/Prettier config, Dockerfile, or GitHub Actions workflow in this repository.

## Setup

```bash
docker compose up -d
cp .env.example .env
npm install
```

`docker compose up -d` starts Postgres as user `devbot`, password `devbot`, database `devbot`, published on host port **5433** (container port 5432). Match `.env.example`:

`DATABASE_URL=postgres://devbot:devbot@localhost:5433/devbot`

Host port 5432 is intentionally left free. Migrations in `migrations/` run on process startup (`runMigrations` in `src/db.ts`), tracked in `schema_migrations`. Editing a file that has already been applied does not re-run it; add a new numbered `migrations/NNN_*.sql` file.

`npm run dev` is `tsx watch src/server.ts` (port from `PORT`, default 3000). `npm start` runs the server once. `GET /health` returns `{ ok: true, service: "devbot" }`.

Cursor, GitHub, and Isometrik cannot reach a loopback `PUBLIC_BASE_URL`. The README's ngrok step (`ngrok http 3000`, then set `PUBLIC_BASE_URL`) is the documented way to expose webhooks. Empty `PUBLIC_BASE_URL` defaults to `http://localhost:3000` and `loadConfig()` logs one warning. The server still starts.

Required env (see `.env.example` and `src/config.ts`): `DATABASE_URL`, `CURSOR_API_KEY`, `CURSOR_WEBHOOK_SECRET` (32+ characters), `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `DEFAULT_REPO` (GitHub URL). `DEFAULT_REF` defaults to `main`. `CURSOR_MODEL` blank means Cursor's default model.

Chat outbound is optional. If `CHAT_POST_URL` or `CHAT_BOT_TOKEN` is empty, `postMessage` logs and returns; inbound requests and Cursor launches still run. `ALLOWED_USER_IDS` and `ALLOWED_CONVERSATION_IDS` are comma-separated; an empty value allows every sender or conversation. Non-matches are ignored with no reply. When `BOT_USER_ID` is set, events from that sender are ignored.

Do not invent Isometrik send-message auth or extra body fields. `src/clients/chat.ts` is explicitly a best-effort body (`conversationId`, `body`, optional `parentMessageId`, `Authorization: Bearer`) with a TODO until official docs exist. Inbound mapping is `parseChatMessage()` in `src/routes/chat.ts` (Isometrik fields first, snake_case aliases kept). The code comments mention `internal/isometrik-chat-mapping.md`; that file is not in this repository.

## Validation

```bash
npm test
npm run typecheck
```

- `npm test` runs `tsx --test tests/**/*.test.ts` (`node:test` and `node:assert/strict`). Covered today: chat parse, `@devbot` trigger, allowlists, related-bug matching, webhook signatures, CI retry / PR planning, and optional chat env. These tests do not need Postgres, Docker, ngrok, or live API keys.
- `npm run typecheck` and `npm run build` are the same command: `tsc -p tsconfig.json --noEmit`. There is no emit step and no linter script.

Config tests call `resetConfigCache()` in `beforeEach` / `afterEach` and pass an explicit env object into `loadConfig`. Reuse `baseEnv` in `tests/config-optional-chat.test.ts` when adding optional env fields. Keep `PUBLIC_BASE_URL` off `baseEnv` so the localhost default stays covered. Do not import `dotenv` from `src/config.ts`; only `src/server.ts` imports `dotenv/config`, and it must stay first so tests remain side-effect free.

A full webhook smoke test needs a filled `.env`, Postgres, and a public `PUBLIC_BASE_URL`. The README curl against `POST /webhooks/chat` is the local check for that path. Unit tests do not replace it, and it is not part of `npm test`.

## Coding conventions

- TypeScript strict, `NodeNext` module resolution. Import local modules with a `.js` suffix (`import { loadConfig } from "./config.js"`), including from tests (`../src/verify.js`).
- Add new environment variables to the zod schema in `src/config.ts` and to `.env.example` together. Callers should use `loadConfig()`, not new `process.env` reads. The one existing exception is `getPool()` in `src/db.ts`, which falls back to `process.env.DATABASE_URL` when no URL is passed. Empty string is a valid "unset" for optional URLs and tokens; do not treat missing chat credentials as a boot failure.
- Prefer a pure function plus a thin I/O wrapper. Decisions that do not need the network live next to the client and are unit-tested: `parseChatMessage`, `isChatAllowed`, `startsWithDevbotMention`, `pickRelatedRequest`, `decideCiRetry`, `planFinishedPullRequest`, `pullRequestTitle`, `pullRequestBody`, `verifyCursorSignature`, `verifyGitHubSignature`.
- Match existing module style: a short file-level comment that says what to reuse and what not to duplicate, typed interfaces, early returns, parameterized SQL (`$1`, `$2`), and `console.error` / `console.warn` / `console.log` prefixes already used (`[devbot]`, `[chat]`, `[db]`, `[github]`, `[cursor]`, `[timeline]`).
- Database columns and status strings are snake_case (`agent_running`, `ci_failed`, `board_card_id`). TypeScript fields on inputs are camelCase. `RequestStatus` in `src/db.ts` is the status union.
- Chat JSON is zod-parsed with `.passthrough()`. Cursor and GitHub bodies are parsed only after the HMAC check, from the raw buffer.
- PR titles this service creates use `pullRequestTitle()`: `DevBot: ` plus the prompt collapsed to one line, clipped so the title is at most 72 characters. PR bodies use `pullRequestBody()`.
- Commit messages in history are short imperative sentences (`Require leading @devbot to start chat requests`).

## Constraints

- Cursor and GitHub routers use `express.raw` and are mounted in `src/server.ts` before `express.json`. Signatures must see the exact bytes. Cursor header: `X-Webhook-Signature`. GitHub header: `X-Hub-Signature-256`. Both are `sha256=` plus HMAC-SHA256 hex, compared with `timingSafeEqual` in `src/verify.ts`. Invalid signatures return 401. Handler failures and bad JSON still return 200 after logging so providers do not retry forever. Duplicate deliveries (`X-Webhook-ID` / `X-GitHub-Delivery`) return `{ ok: true, deduped: true }`.
- The chat webhook always acknowledges quickly with 200, including `{ ok: false, error: "bad_payload" }`. Work runs asynchronously. Allowlist misses produce no reply.
- New requests: trimmed text must match `/^@devbot\b/i`. Mid-message mentions do not start work. On an existing thread, `retry`, `stop`, and `status` are commands; any other text is a follow-up when that request has an `agent_id`.
- Do not launch a second agent for a related bug. `pickRelatedRequest()` decides; `routeRelatedReport()` / `flushPendingFollowups()` deliver. `src/queue.ts` only calls `launchAgent()`. Thread lookup goes through `findRequestByThread()` — do not query `request_threads` from routes. Import `MIN_SHARED_TOKENS`, `MIN_OVERLAP_SCORE`, `RELATED_LOOKBACK_MS`, and `REUSABLE_AGENT_STATUSES` from `src/related.ts` instead of copying the numbers.
- `ensurePullRequest()` returns an existing open PR for the same head. Call it only when `planFinishedPullRequest()` returns `open_pr`. A finish with no branch and no PR URL is a clarification, not a PR.
- GitHub webhook handling ignores branches that do not start with `devbot/`. `GITHUB_TOKEN` needs `actions:read` for job logs and pull-request write for `ensurePullRequest()` (fine-grained `pull_requests: write`, or classic `repo`).
- The running-agent cap (`MAX_RUNNING = 3`) is a constant in `src/queue.ts`, not an env var. Queued work posts `Queued` and starts when `drainQueue()` runs after an agent leaves `agent_running`.
- Never commit `.env`, `.env.local`, or real tokens. `.env.example` stays placeholders. `.gitignore` already excludes those files plus `node_modules/`, `dist/`, and `coverage/`.
- Do not add a linter, formatter, CI workflow, or deploy script that this repository does not already run.

## Pull requests

This repository has no PR template and no CI checks. Before opening a PR:

1. Run `npm test` and `npm run typecheck`.
2. Keep the diff limited to the behavior you changed. Extend the existing client, route, or pure helper instead of adding a parallel one.
3. Add or update a `tests/*.test.ts` case when you change a pure helper (parse, allowlist, related match, signature, CI retry, PR planning, config defaults).
4. If the schema changes, add a new SQL file under `migrations/`. Do not rewrite `001_init.sql` or `002_related_agent.sql` in place.
5. If env changes, update `src/config.ts`, `.env.example`, and the config test's `baseEnv` rules in the same change.
6. Do not commit secrets. Do not claim webhook or Isometrik behavior that `src/clients/chat.ts` still marks as TODO.

Product PRs that DevBot opens on `DEFAULT_REPO` are a different path: `ensurePullRequest()` against `DEFAULT_REF`, title from `pullRequestTitle()`. That path is not the contribution process for this repo.

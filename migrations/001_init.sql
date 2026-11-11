-- DevBot Phase 1 schema.
-- Applied on startup via src/db.ts (tracked in schema_migrations).
-- Reuse these tables for Phase 2 board cards (board_card_id already reserved).

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requests (
  id UUID PRIMARY KEY,
  chat_channel TEXT NOT NULL,
  chat_thread TEXT,
  requested_by TEXT NOT NULL,
  requested_by_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  repo TEXT NOT NULL,
  agent_id TEXT UNIQUE,
  branch TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  status TEXT NOT NULL,
  ci_attempts INTEGER NOT NULL DEFAULT 0,
  board_card_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS requests_chat_thread_idx
  ON requests (chat_channel, chat_thread);

CREATE INDEX IF NOT EXISTS requests_branch_idx
  ON requests (branch);

CREATE INDEX IF NOT EXISTS requests_status_idx
  ON requests (status);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_request_id_created_at_idx
  ON events (request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

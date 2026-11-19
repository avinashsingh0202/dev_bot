-- Related bugs reuse one Cursor agent instead of launching another.
-- request_threads: extra chat threads that belong to an existing request.
--   findRequestByThread() in src/db.ts checks this table — routes should
--   keep using that helper rather than querying here.
-- pending_followups: reports that arrived while that agent was still running.
--   src/followup.ts sends them once the agent is free (one follow-up, not
--   one new launch per report).

CREATE TABLE IF NOT EXISTS request_threads (
  chat_channel TEXT NOT NULL,
  chat_thread TEXT NOT NULL,
  request_id UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_channel, chat_thread)
);

CREATE INDEX IF NOT EXISTS request_threads_request_id_idx
  ON request_threads (request_id);

CREATE TABLE IF NOT EXISTS pending_followups (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pending_followups_request_id_idx
  ON pending_followups (request_id, id);

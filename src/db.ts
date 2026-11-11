/**
 * Postgres pool, migrations-on-startup, and request/event helpers.
 * board_card_id is reserved for Phase 2 — leave null in Phase 1.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export type RequestStatus =
  | "received"
  | "agent_running"
  | "pr_open"
  | "ci_running"
  | "ci_passed"
  | "ci_failed"
  | "gave_up"
  | "agent_error"
  | "stopped"
  | "merged"
  | "closed";

export interface RequestRow {
  id: string;
  chat_channel: string;
  chat_thread: string | null;
  requested_by: string;
  requested_by_name: string;
  prompt: string;
  repo: string;
  agent_id: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  status: RequestStatus;
  ci_attempts: number;
  board_card_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EventRow {
  id: string;
  request_id: string;
  type: string;
  source: string;
  summary: string;
  payload: unknown;
  created_at: Date;
}

let pool: pg.Pool | null = null;

export function getPool(databaseUrl?: string): pg.Pool {
  if (!pool) {
    const connectionString = databaseUrl ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function runMigrations(databaseUrl?: string): Promise<void> {
  const client = await getPool(databaseUrl).connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "migrations",
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE id = $1",
        [file],
      );
      if (existing.rowCount && existing.rowCount > 0) continue;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING",
          [file],
        );
        await client.query("COMMIT");
        console.log(`[db] applied migration ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

export async function createRequest(input: {
  chatChannel: string;
  chatThread: string | null;
  requestedBy: string;
  requestedByName: string;
  prompt: string;
  repo: string;
  /** If omitted, set to `devbot/<first 8 chars of id>`. */
  branch?: string;
}): Promise<RequestRow> {
  const id = randomUUID();
  const branch = input.branch ?? `devbot/${id.slice(0, 8)}`;
  const result = await getPool().query<RequestRow>(
    `INSERT INTO requests (
      id, chat_channel, chat_thread, requested_by, requested_by_name,
      prompt, repo, branch, status, ci_attempts
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',0)
    RETURNING *`,
    [
      id,
      input.chatChannel,
      input.chatThread,
      input.requestedBy,
      input.requestedByName,
      input.prompt,
      input.repo,
      branch,
    ],
  );
  return result.rows[0];
}

export async function getRequestById(id: string): Promise<RequestRow | null> {
  const result = await getPool().query<RequestRow>(
    "SELECT * FROM requests WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findRequestByThread(
  channelId: string,
  threadId: string,
): Promise<RequestRow | null> {
  const result = await getPool().query<RequestRow>(
    `SELECT * FROM requests
     WHERE chat_channel = $1 AND chat_thread = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [channelId, threadId],
  );
  return result.rows[0] ?? null;
}

export async function findRequestByBranch(
  branch: string,
): Promise<RequestRow | null> {
  const result = await getPool().query<RequestRow>(
    "SELECT * FROM requests WHERE branch = $1 ORDER BY created_at DESC LIMIT 1",
    [branch],
  );
  return result.rows[0] ?? null;
}

export async function findRequestByAgentId(
  agentId: string,
): Promise<RequestRow | null> {
  const result = await getPool().query<RequestRow>(
    "SELECT * FROM requests WHERE agent_id = $1",
    [agentId],
  );
  return result.rows[0] ?? null;
}

export async function updateRequest(
  id: string,
  patch: Partial<{
    agent_id: string | null;
    branch: string | null;
    pr_url: string | null;
    pr_number: number | null;
    status: RequestStatus;
    ci_attempts: number;
  }>,
): Promise<RequestRow> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = $${i++}`);
    values.push(value);
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await getPool().query<RequestRow>(
    `UPDATE requests SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  if (!result.rows[0]) throw new Error(`Request ${id} not found`);
  return result.rows[0];
}

export async function countRunningAgents(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM requests
     WHERE status = 'agent_running'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function logEvent(input: {
  requestId: string;
  type: string;
  source: string;
  summary: string;
  payload?: unknown;
}): Promise<EventRow> {
  const result = await getPool().query<EventRow>(
    `INSERT INTO events (request_id, type, source, summary, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.requestId,
      input.type,
      input.source,
      input.summary,
      input.payload == null ? null : JSON.stringify(input.payload),
    ],
  );
  return result.rows[0];
}

export async function listEventsForRequest(
  requestId: string,
): Promise<EventRow[]> {
  const result = await getPool().query<EventRow>(
    `SELECT * FROM events
     WHERE request_id = $1
     ORDER BY created_at DESC, id DESC`,
    [requestId],
  );
  return result.rows;
}

/** Returns true if this delivery_id is new (inserted). False if duplicate. */
export async function claimWebhookDelivery(
  deliveryId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO webhook_deliveries (delivery_id)
     VALUES ($1)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [deliveryId],
  );
  return (result.rowCount ?? 0) > 0;
}

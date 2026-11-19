/**
 * Query helpers against an in-memory pool. No Postgres.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import {
  claimWebhookDelivery,
  closePool,
  countRunningAgents,
  createRequest,
  enqueuePendingFollowup,
  findRequestByAgentId,
  findRequestByBranch,
  findRequestByThread,
  getPool,
  getRequestById,
  linkRequestThread,
  listEventsForRequest,
  listReusableRequests,
  logEvent,
  runMigrations,
  setPoolForTests,
  takePendingFollowups,
  updateRequest,
} from "../src/db.js";

interface QueryCall {
  sql: string;
  params?: unknown[];
}

interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
}

const state = {
  queries: [] as QueryCall[],
  clientQueries: [] as QueryCall[],
  releases: 0,
  ends: 0,
  onQuery(_sql: string, _params?: unknown[]): QueryResult {
    return { rows: [], rowCount: 0 };
  },
  onClientQuery(_sql: string, _params?: unknown[]): QueryResult {
    return { rows: [], rowCount: 0 };
  },
};

const fakePool = {
  async query(sql: string, params?: unknown[]) {
    state.queries.push({ sql, params });
    return state.onQuery(sql, params);
  },
  async connect() {
    return {
      async query(sql: string, params?: unknown[]) {
        state.clientQueries.push({ sql, params });
        return state.onClientQuery(sql, params);
      },
      release() {
        state.releases += 1;
      },
    };
  },
  async end() {
    state.ends += 1;
  },
};

function resetState(): void {
  state.queries = [];
  state.clientQueries = [];
  state.releases = 0;
  state.ends = 0;
  state.onQuery = () => ({ rows: [], rowCount: 0 });
  state.onClientQuery = () => ({ rows: [], rowCount: 0 });
}

describe("pool lifecycle", () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    setPoolForTests(null);
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it("throws when DATABASE_URL is missing", () => {
    setPoolForTests(null);
    delete process.env.DATABASE_URL;
    assert.throws(() => getPool(), /DATABASE_URL is required/);
  });

  it("reuses the cached pool until closePool", async () => {
    resetState();
    delete process.env.DATABASE_URL;
    setPoolForTests(fakePool as unknown as pg.Pool);
    assert.equal(getPool(), fakePool);
    assert.equal(getPool("postgres://other"), fakePool);
    await closePool();
    assert.equal(state.ends, 1);
    assert.throws(() => getPool(), /DATABASE_URL is required/);
  });
});

describe("request and event queries", () => {
  beforeEach(() => {
    resetState();
    setPoolForTests(fakePool as unknown as pg.Pool);
  });

  afterEach(() => {
    setPoolForTests(null);
  });

  it("inserts a request and defaults the branch from the id", async () => {
    state.onQuery = () => ({ rows: [{ id: "stored" }], rowCount: 1 });
    const row = await createRequest({
      chatChannel: "conv",
      chatThread: null,
      requestedBy: "user",
      requestedByName: "Ada",
      prompt: "fix login",
      repo: "https://github.com/acme/app",
    });
    assert.equal(row.id, "stored");
    const call = state.queries[0]!;
    assert.match(call.sql, /INSERT INTO requests/);
    assert.match(call.sql, /'received'/);
    const params = call.params ?? [];
    assert.match(String(params[0]), /^[0-9a-f-]{36}$/);
    assert.equal(params[1], "conv");
    assert.equal(params[2], null);
    assert.equal(params[3], "user");
    assert.equal(params[4], "Ada");
    assert.equal(params[5], "fix login");
    assert.equal(params[6], "https://github.com/acme/app");
    assert.equal(params[7], `devbot/${String(params[0]).slice(0, 8)}`);
  });

  it("keeps an explicit branch", async () => {
    state.onQuery = () => ({ rows: [{ id: "stored" }], rowCount: 1 });
    await createRequest({
      chatChannel: "c",
      chatThread: "t",
      requestedBy: "u",
      requestedByName: "Ada",
      prompt: "p",
      repo: "r",
      branch: "devbot/custom",
    });
    assert.equal(state.queries[0]!.params?.[7], "devbot/custom");
  });

  it("returns a request or null by id, branch, agent, and thread", async () => {
    const stored = { id: "r1" };
    state.onQuery = (_sql, params) => {
      if (params?.[0] === "missing") return { rows: [], rowCount: 0 };
      return { rows: [stored], rowCount: 1 };
    };

    assert.deepEqual(await getRequestById("r1"), stored);
    assert.equal(await getRequestById("missing"), null);
    assert.match(state.queries[0]!.sql, /WHERE id = \$1/);

    assert.deepEqual(await findRequestByBranch("devbot/abc"), stored);
    assert.match(state.queries[2]!.sql, /WHERE branch = \$1/);
    assert.deepEqual(state.queries[2]!.params, ["devbot/abc"]);

    assert.deepEqual(await findRequestByAgentId("agent-1"), stored);
    assert.match(state.queries[3]!.sql, /WHERE agent_id = \$1/);

    assert.deepEqual(await findRequestByThread("conv", "thread"), stored);
    const threadSql = state.queries[4]!.sql;
    assert.match(threadSql, /request_threads/);
    assert.deepEqual(state.queries[4]!.params, ["conv", "thread"]);
  });

  it("lists reusable requests with the caller's status set", async () => {
    const since = new Date("2026-11-01T00:00:00Z");
    state.onQuery = () => ({ rows: [{ id: "r1" }], rowCount: 1 });
    const rows = await listReusableRequests({
      chatChannel: "conv",
      repo: "https://github.com/acme/app",
      since,
      statuses: ["pr_open", "agent_running"],
    });
    assert.equal(rows.length, 1);
    assert.match(state.queries[0]!.sql, /agent_id IS NOT NULL/);
    assert.deepEqual(state.queries[0]!.params, [
      "conv",
      "https://github.com/acme/app",
      ["pr_open", "agent_running"],
      since,
    ]);
  });

  it("links a thread and queues a pending follow-up", async () => {
    await linkRequestThread({
      chatChannel: "conv",
      chatThread: "thread",
      requestId: "r1",
    });
    assert.match(state.queries[0]!.sql, /ON CONFLICT \(chat_channel, chat_thread\)/);
    assert.deepEqual(state.queries[0]!.params, ["conv", "thread", "r1"]);

    await enqueuePendingFollowup({
      requestId: "r1",
      senderName: "Ada",
      text: "still broken",
    });
    assert.match(state.queries[1]!.sql, /INSERT INTO pending_followups/);
    assert.deepEqual(state.queries[1]!.params, ["r1", "Ada", "still broken"]);
  });

  it("takes pending follow-ups oldest-first inside a transaction", async () => {
    state.onClientQuery = (sql) => {
      if (sql.includes("DELETE")) {
        return {
          rows: [
            { id: "10", sender_name: "Ada", text: "later" },
            { id: "2", sender_name: "Bea", text: "earlier" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const rows = await takePendingFollowups("r1");
    assert.deepEqual(
      rows.map((row) => row.id),
      ["2", "10"],
    );
    assert.deepEqual(
      state.clientQueries.map((query) => query.sql),
      [
        "BEGIN",
        expectDelete("r1"),
        "COMMIT",
      ],
    );
    assert.equal(state.releases, 1);
  });

  it("rolls back and releases when taking follow-ups fails", async () => {
    state.onClientQuery = (sql) => {
      if (sql === "BEGIN") throw new Error("tx down");
      return { rows: [], rowCount: 0 };
    };
    await assert.rejects(takePendingFollowups("r1"), /tx down/);
    assert.deepEqual(
      state.clientQueries.map((query) => query.sql),
      ["BEGIN", "ROLLBACK"],
    );
    assert.equal(state.releases, 1);
  });

  it("builds an update from defined fields and rejects a missing row", async () => {
    state.onQuery = () => ({ rows: [{ id: "r1", status: "stopped" }], rowCount: 1 });
    const updated = await updateRequest("r1", {
      status: "stopped",
      pr_number: null,
      agent_id: undefined,
      branch: "devbot/abc",
    });
    assert.equal(updated.status, "stopped");
    assert.equal(
      state.queries[0]!.sql,
      "UPDATE requests SET status = $1, pr_number = $2, branch = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
    );
    assert.deepEqual(state.queries[0]!.params, ["stopped", null, "devbot/abc", "r1"]);

    state.queries = [];
    state.onQuery = () => ({ rows: [{ id: "r1" }], rowCount: 1 });
    await updateRequest("r1", {});
    assert.equal(
      state.queries[0]!.sql,
      "UPDATE requests SET updated_at = NOW() WHERE id = $1 RETURNING *",
    );
    assert.deepEqual(state.queries[0]!.params, ["r1"]);

    state.onQuery = () => ({ rows: [], rowCount: 0 });
    await assert.rejects(updateRequest("missing", { status: "stopped" }), /Request missing not found/);
  });

  it("counts running agents and claims webhook deliveries once", async () => {
    state.onQuery = () => ({ rows: [{ count: "4" }], rowCount: 1 });
    assert.equal(await countRunningAgents(), 4);
    state.onQuery = () => ({ rows: [], rowCount: 0 });
    assert.equal(await countRunningAgents(), 0);

    state.onQuery = () => ({ rows: [{ delivery_id: "cursor:1" }], rowCount: 1 });
    assert.equal(await claimWebhookDelivery("cursor:1"), true);
    state.onQuery = () => ({ rows: [], rowCount: 0 });
    assert.equal(await claimWebhookDelivery("cursor:1"), false);
    state.onQuery = () => ({ rows: [], rowCount: null });
    assert.equal(await claimWebhookDelivery("cursor:1"), false);
    assert.match(state.queries.at(-1)!.sql, /ON CONFLICT \(delivery_id\) DO NOTHING/);
  });

  it("stores event payloads as JSON and lists them newest-first", async () => {
    state.onQuery = () => ({ rows: [{ id: "1" }], rowCount: 1 });
    await logEvent({
      requestId: "r1",
      type: "received",
      source: "chat",
      summary: "On it",
      payload: { prompt: "fix" },
    });
    assert.deepEqual(state.queries[0]!.params, [
      "r1",
      "received",
      "chat",
      "On it",
      JSON.stringify({ prompt: "fix" }),
    ]);

    await logEvent({
      requestId: "r1",
      type: "status",
      source: "chat",
      summary: "Status",
    });
    assert.equal(state.queries[1]!.params?.[4], null);

    const events = await listEventsForRequest("r1");
    assert.equal(events.length, 1);
    assert.match(state.queries[2]!.sql, /ORDER BY created_at DESC, id DESC/);
    assert.deepEqual(state.queries[2]!.params, ["r1"]);
  });
});

function expectDelete(requestId: string): string {
  const query = state.clientQueries.find((call) => call.sql.includes("DELETE"));
  assert.ok(query);
  assert.deepEqual(query.params, [requestId]);
  return query.sql;
}

describe("migrations", () => {
  beforeEach(() => {
    resetState();
    setPoolForTests(fakePool as unknown as pg.Pool);
  });

  afterEach(() => {
    setPoolForTests(null);
  });

  it("applies each SQL file once, in order, and skips it the next time", async () => {
    const applied: string[] = [];
    state.onClientQuery = (sql, params) => {
      if (sql.includes("SELECT 1 FROM schema_migrations")) {
        const id = String(params?.[0]);
        const already = applied.includes(id);
        return { rows: already ? [{}] : [], rowCount: already ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        applied.push(String(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    };

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runMigrations("postgres://unused");
      await runMigrations("postgres://unused");
    } finally {
      console.log = original;
    }

    assert.deepEqual(applied, ["001_init.sql", "002_related_agent.sql"]);
    assert.ok(
      state.clientQueries.some((query) =>
        query.sql.includes("CREATE TABLE IF NOT EXISTS requests"),
      ),
    );
    assert.ok(
      state.clientQueries.some((query) => query.sql.includes("pending_followups")),
    );
    assert.equal(
      state.clientQueries.filter((query) => query.sql === "COMMIT").length,
      2,
    );
    assert.equal(state.releases, 2);
    assert.deepEqual(logs, [
      "[db] applied migration 001_init.sql",
      "[db] applied migration 002_related_agent.sql",
    ]);
  });

  it("rolls back a failed migration and releases the client", async () => {
    const applied: string[] = [];
    state.onClientQuery = (sql, params) => {
      if (sql.includes("pending_followups")) throw new Error("sql failed");
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        applied.push(String(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    };
    const original = console.log;
    console.log = () => {};
    try {
      await assert.rejects(runMigrations(), /sql failed/);
    } finally {
      console.log = original;
    }
    assert.deepEqual(applied, ["001_init.sql"]);
    assert.ok(state.clientQueries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(
      state.clientQueries.filter((query) => query.sql === "COMMIT").length,
      1,
    );
    assert.equal(state.releases, 1);
  });
});

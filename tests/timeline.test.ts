/**
 * Timeline endpoint with the database module mocked.
 */
import assert from "node:assert/strict";
import { mock, describe, it } from "node:test";
import { requestRow, requestJson, withServer } from "./helpers.js";

const state = {
  request: null as ReturnType<typeof requestRow> | null,
  events: [] as {
    id: string;
    type: string;
    summary: string;
    created_at: Date;
  }[],
  throwOnRead: false,
  listCalls: 0,
  ids: [] as string[],
};

function unexpected(name: string) {
  return async () => {
    throw new Error(`unexpected db call: ${name}`);
  };
}

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    createRequest: unexpected("createRequest"),
    findRequestByThread: unexpected("findRequestByThread"),
    listReusableRequests: unexpected("listReusableRequests"),
    logEvent: unexpected("logEvent"),
    updateRequest: unexpected("updateRequest"),
    claimWebhookDelivery: unexpected("claimWebhookDelivery"),
    findRequestByAgentId: unexpected("findRequestByAgentId"),
    findRequestByBranch: unexpected("findRequestByBranch"),
    enqueuePendingFollowup: unexpected("enqueuePendingFollowup"),
    linkRequestThread: unexpected("linkRequestThread"),
    takePendingFollowups: unexpected("takePendingFollowups"),
    countRunningAgents: unexpected("countRunningAgents"),
    getRequestById: async (id: string) => {
      state.ids.push(id);
      if (state.throwOnRead) throw new Error("db down");
      return state.request;
    },
    listEventsForRequest: async (id: string) => {
      state.listCalls += 1;
      state.ids.push(`events:${id}`);
      return state.events;
    },
  },
});

const { createApp } = await import("../src/app.js");
const app = createApp();

describe("GET /requests/:id/timeline", () => {
  it("returns the request and its events", async () => {
    state.throwOnRead = false;
    state.listCalls = 0;
    state.ids = [];
    state.request = requestRow();
    state.events = [
      {
        id: "9",
        type: "received",
        summary: "On it",
        created_at: new Date("2026-11-01T00:00:00Z"),
      },
    ];

    await withServer(app, async (base) => {
      const res = await requestJson(
        `${base}/requests/${state.request!.id}/timeline`,
      );
      assert.equal(res.status, 200);
      const body = res.json as {
        ok: boolean;
        request: { id: string; status: string };
        events: { summary: string; created_at: string }[];
      };
      assert.equal(body.ok, true);
      assert.equal(body.request.id, state.request!.id);
      assert.equal(body.request.status, "pr_open");
      assert.equal(body.events[0]!.summary, "On it");
      assert.equal(body.events[0]!.created_at, "2026-11-01T00:00:00.000Z");
    });
    assert.deepEqual(state.ids, [state.request.id, `events:${state.request.id}`]);
  });

  it("returns 404 when the request does not exist", async () => {
    state.throwOnRead = false;
    state.request = null;
    state.listCalls = 0;
    await withServer(app, async (base) => {
      const res = await requestJson(`${base}/requests/missing/timeline`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, { ok: false, error: "not_found" });
    });
    assert.equal(state.listCalls, 0);
  });

  it("returns 500 when the database read fails", async () => {
    state.throwOnRead = true;
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await withServer(app, async (base) => {
        const res = await requestJson(`${base}/requests/missing/timeline`);
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { ok: false, error: "internal_error" });
      });
    } finally {
      console.error = original;
    }
    assert.match(errors[0]!, /\[timeline\] error/);
    assert.match(errors[0]!, /db down/);
  });
});

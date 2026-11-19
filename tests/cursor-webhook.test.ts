/**
 * Cursor status webhook with db, chat, GitHub, and the launch queue mocked.
 */
import assert from "node:assert/strict";
import express from "express";
import { mock, afterEach, beforeEach, describe, it } from "node:test";
import {
  planFinishedPullRequest,
  pullRequestBody,
  pullRequestTitle,
} from "../src/clients/github.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { requestRow, requestJson, signBody, testEnv, withServer } from "./helpers.js";

interface PrCall {
  head: string;
  base: string;
  title: string;
  body: string;
}

const state = {
  request: null as ReturnType<typeof requestRow> | null,
  claimNew: true,
  claims: [] as string[],
  finds: [] as string[],
  findError: null as Error | null,
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  posts: [] as { text: string }[],
  events: [] as { type: string; summary: string }[],
  prCalls: [] as PrCall[],
  prResult: {
    ok: true as const,
    number: 9,
    htmlUrl: "https://github.com/acme/app/pull/9",
    created: true,
  } as
    | { ok: true; number: number; htmlUrl: string; created: boolean }
    | { ok: false; reason: "no_commits" | "github_error"; detail: string },
  prError: null as Error | null,
  flushes: 0,
  drains: 0,
};

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    claimWebhookDelivery: async (id: string) => {
      state.claims.push(id);
      return state.claimNew;
    },
    findRequestByAgentId: async (agentId: string) => {
      state.finds.push(agentId);
      if (state.findError) throw state.findError;
      return state.request;
    },
    logEvent: async (input: { type: string; summary: string }) => {
      state.events.push(input);
    },
    updateRequest: async (id: string, patch: Record<string, unknown>) => {
      state.updates.push({ id, patch });
    },
  },
});

mock.module("../src/clients/chat.ts", {
  cache: true,
  namedExports: {
    postMessage: async (_channel: string, _thread: string | null, text: string) => {
      state.posts.push({ text });
    },
  },
});

mock.module("../src/clients/github.ts", {
  cache: true,
  namedExports: {
    planFinishedPullRequest,
    pullRequestBody,
    pullRequestTitle,
    ensurePullRequest: async (input: PrCall) => {
      state.prCalls.push(input);
      if (state.prError) throw state.prError;
      return state.prResult;
    },
  },
});

mock.module("../src/followup.ts", {
  cache: true,
  namedExports: {
    flushPendingFollowups: async () => {
      state.flushes += 1;
      return false;
    },
  },
});

mock.module("../src/queue.ts", {
  cache: true,
  namedExports: {
    drainQueue: async () => {
      state.drains += 1;
    },
  },
});

const { createCursorRouter } = await import("../src/routes/cursor.js");
const app = express();
app.use(createCursorRouter());

function reset(): void {
  state.request = requestRow();
  state.claimNew = true;
  state.claims = [];
  state.finds = [];
  state.findError = null;
  state.updates = [];
  state.posts = [];
  state.events = [];
  state.prCalls = [];
  state.prResult = {
    ok: true,
    number: 9,
    htmlUrl: "https://github.com/acme/app/pull/9",
    created: true,
  };
  state.prError = null;
  state.flushes = 0;
  state.drains = 0;
  resetConfigCache();
  loadConfig({ ...testEnv });
}

async function postCursor(
  body: unknown,
  headers: Record<string, string> = {},
  rawOverride?: string,
): Promise<{ status: number; json: unknown }> {
  const raw = rawOverride ?? JSON.stringify(body);
  let result = { status: 0, json: undefined as unknown };
  await withServer(app, async (base) => {
    result = await requestJson(`${base}/webhooks/cursor`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signBody("x".repeat(32), raw),
        ...headers,
      },
      body: raw,
    });
  });
  return result;
}

describe("Cursor status webhook", () => {
  beforeEach(() => reset());
  afterEach(() => resetConfigCache());

  it("records a PR Cursor already opened", async () => {
    const res = await postCursor({
      id: "agent-1",
      status: "finished",
      summary: " Renamed the button. ",
      target: {
        prUrl: "https://github.com/acme/app/pull/4",
        branchName: "devbot/11111111",
        url: "https://cursor.com/agents/agent-1",
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(state.prCalls.length, 0);
    assert.deepEqual(state.updates[0]!.patch, {
      status: "pr_open",
      pr_url: "https://github.com/acme/app/pull/4",
      branch: "devbot/11111111",
    });
    assert.match(state.posts[0]!.text, /PR opened: https:\/\/github.com\/acme\/app\/pull\/4/);
    assert.match(state.posts[0]!.text, /Renamed the button/);
    assert.equal(state.events[0]!.type, "pr_open");
    assert.equal(state.flushes, 1);
    assert.equal(state.drains, 1);
  });

  it("opens a PR when the finish webhook has a branch and no PR url", async () => {
    resetConfigCache();
    loadConfig({ ...testEnv, DEFAULT_REF: "develop" });
    const res = await postCursor({
      id: "agent-1",
      status: "FINISHED",
      summary: "Fixed login.",
      target: {
        prUrl: "  ",
        branchName: "devbot/11111111",
        url: "https://cursor.com/agents/agent-1",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(state.prCalls.length, 1);
    assert.equal(state.prCalls[0]!.head, "devbot/11111111");
    assert.equal(state.prCalls[0]!.base, "develop");
    assert.equal(state.prCalls[0]!.title, "DevBot: login button broken on checkout");
    assert.match(state.prCalls[0]!.body, /Fixed login/);
    assert.match(state.prCalls[0]!.body, /login button broken on checkout/);
    assert.match(state.prCalls[0]!.body, /cursor.com\/agents\/agent-1/);
    assert.deepEqual(state.updates[0]!.patch, {
      status: "pr_open",
      pr_url: "https://github.com/acme/app/pull/9",
      pr_number: 9,
      branch: "devbot/11111111",
    });
  });

  it("asks for clarification when the branch has no commits", async () => {
    state.prResult = {
      ok: false,
      reason: "no_commits",
      detail: "No commits between main and devbot/11111111",
    };
    await postCursor({
      id: "agent-1",
      status: "FINISHED",
      summary: "Nothing to change.",
      target: { branchName: "devbot/11111111" },
    });
    assert.equal(state.updates[0]!.patch.status, "agent_error");
    assert.match(state.posts[0]!.text, /Nothing to change/);
    assert.match(state.posts[0]!.text, /Please clarify/);
    assert.equal(state.events[0]!.type, "needs_clarification");
    assert.equal(state.flushes, 1);
  });

  it("asks for clarification when the agent finished with no branch", async () => {
    state.request = requestRow({ branch: null });
    await postCursor({
      id: "agent-1",
      status: "FINISHED",
      summary: "",
    });
    assert.equal(state.prCalls.length, 0);
    assert.match(state.posts[0]!.text, /\(no summary\)/);
    assert.equal(state.events[0]!.type, "needs_clarification");
  });

  it("reports a GitHub failure and a thrown client error", async () => {
    state.prResult = { ok: false, reason: "github_error", detail: "500 down" };
    await postCursor({
      id: "agent-1",
      status: "FINISHED",
      target: { branchName: "devbot/11111111" },
    });
    assert.match(state.posts[0]!.text, /opening the PR failed: 500 down/);
    assert.equal(state.events[0]!.type, "agent_error");
    assert.equal(state.drains, 1);
    assert.equal(state.flushes, 1);

    state.posts = [];
    state.events = [];
    state.drains = 0;
    state.prError = new Error("socket");
    await postCursor({
      id: "agent-1",
      status: "FINISHED",
      target: { branchName: "devbot/11111111" },
    });
    assert.match(state.posts[0]!.text, /opening the PR failed: socket/);
    assert.equal(state.drains, 1);
  });

  it("posts an agent error and ignores a non-terminal status", async () => {
    await postCursor({
      id: "agent-1",
      status: "ERROR",
      error: { message: "boom" },
    });
    assert.equal(state.updates[0]!.patch.status, "agent_error");
    assert.match(state.posts[0]!.text, /Agent error: boom/);
    assert.match(state.posts[0]!.text, /Reply retry/);
    assert.equal(state.drains, 1);

    state.posts = [];
    state.updates = [];
    state.drains = 0;
    await postCursor({ id: "agent-1", status: "ERROR", error: "plain" });
    assert.match(state.posts[0]!.text, /Agent error: plain/);

    state.posts = [];
    await postCursor({ id: "agent-1", status: "ERROR", error: {} });
    assert.match(state.posts[0]!.text, /Agent error: unknown error/);

    state.updates = [];
    state.posts = [];
    state.drains = 0;
    state.flushes = 0;
    const running = await postCursor({ id: "agent-1", status: "RUNNING" });
    assert.deepEqual(running.json, { ok: true });
    assert.equal(state.updates.length, 0);
    assert.equal(state.drains, 0);
    assert.equal(state.flushes, 0);
  });

  it("dedupes a delivery and survives a missing request or handler failure", async () => {
    state.claimNew = false;
    const dup = await postCursor(
      { id: "agent-1", status: "FINISHED" },
      { "x-webhook-id": "delivery-1" },
    );
    assert.deepEqual(dup.json, { ok: true, deduped: true });
    assert.deepEqual(state.claims, ["cursor:delivery-1"]);
    assert.equal(state.finds.length, 0);

    state.claimNew = true;
    state.request = null;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const missing = await postCursor({ id: "missing-agent", status: "FINISHED" });
      assert.deepEqual(missing.json, { ok: true });
    } finally {
      console.warn = originalWarn;
    }
    assert.match(warnings[0]!, /no request for agent missing-agent/);
    assert.equal(state.updates.length, 0);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    state.findError = new Error("db down");
    try {
      const failed = await postCursor({ id: "agent-1", status: "ERROR" });
      assert.deepEqual(failed.json, { ok: false, error: "handler_error" });
    } finally {
      console.error = originalError;
    }
    assert.match(errors[0]!, /webhook handler error/);
  });
});

/**
 * Inbound chat processing with db, outbound chat, Cursor, and the queue mocked.
 * Allowlist and related-bug matching stay real.
 */
import assert from "node:assert/strict";
import express from "express";
import { mock, afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfigCache } from "../src/config.js";
import type { RequestRow } from "../src/db.js";
import { requestRow, requestJson, settle, testEnv, withServer } from "./helpers.js";

interface CreatedRequest {
  chatChannel: string;
  chatThread: string | null;
  requestedBy: string;
  requestedByName: string;
  prompt: string;
  repo: string;
}

const state = {
  thread: null as RequestRow | null,
  open: [] as RequestRow[],
  created: [] as CreatedRequest[],
  posts: [] as { channel: string; thread: string | null | undefined; text: string }[],
  events: [] as { type: string; summary: string; payload?: { prompt?: string; text?: string } }[],
  updates: [] as { id: string; patch: { status?: string } }[],
  followups: [] as { agentId: string; text: string }[],
  routes: [] as { reason: string; text: string; senderName: string; replyThread: string }[],
  launches: [] as { senderName: string; text: string; requestId: string }[],
  routeResult: "sent" as "sent" | "queued" | "agent_gone",
  routeError: null as Error | null,
  createError: null as Error | null,
  listCalls: 0,
  threadCalls: 0,
};

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    createRequest: async (input: CreatedRequest) => {
      state.created.push(input);
      if (state.createError) throw state.createError;
      return requestRow({
        id: "created-id",
        prompt: input.prompt,
        chat_channel: input.chatChannel,
        chat_thread: input.chatThread,
        requested_by: input.requestedBy,
        requested_by_name: input.requestedByName,
        repo: input.repo,
        agent_id: null,
        branch: null,
        pr_url: null,
        pr_number: null,
        status: "received",
      });
    },
    findRequestByThread: async () => {
      state.threadCalls += 1;
      return state.thread;
    },
    listReusableRequests: async () => {
      state.listCalls += 1;
      return state.open;
    },
    logEvent: async (input: {
      type: string;
      summary: string;
      payload?: { prompt?: string; text?: string };
    }) => {
      state.events.push(input);
    },
    updateRequest: async (id: string, patch: { status?: string }) => {
      state.updates.push({ id, patch });
    },
  },
});

mock.module("../src/clients/chat.ts", {
  cache: true,
  namedExports: {
    postMessage: async (
      channel: string,
      thread: string | null | undefined,
      text: string,
    ) => {
      state.posts.push({ channel, thread, text });
    },
  },
});

mock.module("../src/clients/cursor.ts", {
  cache: true,
  namedExports: {
    sendFollowup: async (agentId: string, text: string) => {
      state.followups.push({ agentId, text });
    },
  },
});

mock.module("../src/followup.ts", {
  cache: true,
  namedExports: {
    routeRelatedReport: async (input: {
      reason: string;
      text: string;
      senderName: string;
      replyThread: string;
    }) => {
      state.routes.push(input);
      if (state.routeError) throw state.routeError;
      return state.routeResult;
    },
  },
});

mock.module("../src/queue.ts", {
  cache: true,
  namedExports: {
    enqueueOrLaunch: async (item: {
      request: RequestRow;
      senderName: string;
      text: string;
    }) => {
      state.launches.push({
        senderName: item.senderName,
        text: item.text,
        requestId: item.request.id,
      });
    },
  },
});

const { createChatRouter } = await import("../src/routes/chat.js");
const app = express();
app.use(express.json());
app.use(createChatRouter());

function reset(): void {
  state.thread = null;
  state.open = [];
  state.created = [];
  state.posts = [];
  state.events = [];
  state.updates = [];
  state.followups = [];
  state.routes = [];
  state.launches = [];
  state.routeResult = "sent";
  state.routeError = null;
  state.createError = null;
  state.listCalls = 0;
  state.threadCalls = 0;
  resetConfigCache();
  loadConfig({
    ...testEnv,
    ALLOWED_USER_IDS: "user-1",
    ALLOWED_CONVERSATION_IDS: "conv-1",
    BOT_USER_ID: "bot-1",
  });
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "chatMessageSent",
    messageId: "m1",
    conversationId: "conv-1",
    senderId: "user-1",
    senderName: "Ada",
    body: "@devbot fix login",
    ...overrides,
  };
}

async function postChat(body: unknown): Promise<{ status: number; json: unknown }> {
  let result = { status: 0, json: undefined as unknown };
  await withServer(app, async (base) => {
    result = await requestJson(`${base}/webhooks/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await settle();
  });
  return result;
}

describe("chat webhook", () => {
  beforeEach(() => reset());
  afterEach(() => resetConfigCache());

  it("acks quickly and ignores senders or conversations outside the allowlist", async () => {
    const bad = await postChat({ body: "no ids" });
    assert.equal(bad.status, 200);
    assert.deepEqual(bad.json, { ok: false, error: "bad_payload" });
    assert.equal(state.threadCalls, 0);

    const outsider = await postChat(message({ senderId: "someone-else", body: "@devbot fix" }));
    assert.deepEqual(outsider.json, { ok: true });
    assert.equal(state.threadCalls, 0);

    await postChat(message({ conversationId: "other", body: "@devbot fix" }));
    await postChat(message({ senderId: "bot-1", body: "@devbot fix" }));
    assert.equal(state.created.length, 0);
    assert.equal(state.posts.length, 0);
  });

  it("runs thread commands and forwards a normal reply", async () => {
    state.thread = requestRow();
    await postChat(
      message({
        messageId: "m2",
        parentMessageId: "thread-1",
        body: " RETRY ",
      }),
    );
    assert.equal(state.followups[0]!.agentId, "agent-1");
    assert.match(state.followups[0]!.text, /Ada says: please retry/);
    assert.deepEqual(state.updates[0]!.patch, { status: "agent_running" });
    assert.equal(state.posts[0]!.text, "Retry requested — agent follow-up sent");
    assert.equal(state.events[0]!.type, "retry");

    state.followups = [];
    state.updates = [];
    state.posts = [];
    state.thread = requestRow({ agent_id: null });
    await postChat(message({ parentMessageId: "thread-1", body: "retry" }));
    assert.equal(state.posts[0]!.text, "No agent to retry yet");
    assert.equal(state.followups.length, 0);
    assert.equal(state.updates.length, 0);

    state.posts = [];
    state.thread = requestRow();
    await postChat(message({ parentMessageId: "thread-1", body: "Stop" }));
    assert.deepEqual(state.updates[0]!.patch, { status: "stopped" });
    assert.equal(state.posts[0]!.text, "Stopped");
    assert.equal(state.events.at(-1)!.type, "stopped");

    state.updates = [];
    state.posts = [];
    state.thread = requestRow({ branch: null, pr_url: null, ci_attempts: 2, status: "agent_error" });
    await postChat(message({ parentMessageId: "thread-1", body: "status" }));
    assert.equal(state.updates.length, 0);
    assert.equal(state.posts[0]!.text, "Status: agent_error\nCI attempts: 2");

    state.thread = requestRow({ ci_attempts: 1 });
    await postChat(message({ parentMessageId: "thread-1", body: "status" }));
    assert.match(state.posts.at(-1)!.text, /Status: pr_open/);
    assert.match(state.posts.at(-1)!.text, /Branch: devbot\/11111111/);
    assert.match(state.posts.at(-1)!.text, /PR: https:\/\/github.com\/acme\/app\/pull\/4/);
    assert.match(state.posts.at(-1)!.text, /CI attempts: 1/);

    state.followups = [];
    state.events = [];
    await postChat(
      message({ parentMessageId: "thread-1", body: "please also check mobile" }),
    );
    assert.equal(
      state.followups[0]!.text,
      "Ada says: please also check mobile",
    );
    assert.equal(state.events.at(-1)!.type, "followup");
    assert.equal(state.events.at(-1)!.payload?.text, "please also check mobile");

    state.followups = [];
    state.events = [];
    state.thread = requestRow({ agent_id: null });
    await postChat(message({ parentMessageId: "thread-1", body: "more detail" }));
    assert.equal(state.followups.length, 0);
    assert.equal(state.events.length, 0);
  });

  it("starts a new agent for an @devbot request that matches nothing open", async () => {
    const res = await postChat(message({ body: "  @DevBot fix login  " }));
    assert.deepEqual(res.json, { ok: true });
    assert.equal(state.listCalls, 1);
    assert.deepEqual(state.created[0], {
      chatChannel: "conv-1",
      chatThread: "m1",
      requestedBy: "user-1",
      requestedByName: "Ada",
      prompt: "fix login",
      repo: "https://github.com/acme/app",
    });
    assert.equal(state.posts[0]!.text, "On it");
    assert.equal(state.events[0]!.type, "received");
    assert.equal(state.events[0]!.payload?.prompt, "fix login");
    assert.deepEqual(state.launches, [
      { senderName: "Ada", text: "fix login", requestId: "created-id" },
    ]);
  });

  it("does not start an agent for a mid-message mention", async () => {
    await postChat(message({ body: "please @devbot fix this" }));
    assert.equal(state.created.length, 0);
    assert.equal(state.listCalls, 0);
    assert.equal(state.launches.length, 0);
  });

  it("routes a related report and launches only when that agent is gone", async () => {
    state.open = [requestRow()];
    await postChat(message({ body: "@devbot the login button is still broken" }));
    assert.equal(state.routes.length, 1);
    assert.equal(state.routes[0]!.reason, "overlap");
    assert.equal(state.routes[0]!.senderName, "Ada");
    assert.match(state.routes[0]!.text, /login button is still broken/);
    assert.equal(state.created.length, 0);
    assert.equal(state.launches.length, 0);

    state.routeResult = "queued";
    state.routes = [];
    await postChat(message({ body: "@devbot the login button is still broken" }));
    assert.equal(state.created.length, 0);

    state.routeResult = "agent_gone";
    await postChat(message({ body: "@devbot the login button is still broken" }));
    assert.equal(state.created.length, 1);
    assert.equal(state.launches.length, 1);

    state.routeError = new Error("follow-up down");
    state.created = [];
    state.launches = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await postChat(message({ body: "@devbot the login button is still broken" }));
    } finally {
      console.error = original;
    }
    assert.match(errors[0]!, /related follow-up failed/);
    assert.equal(state.created.length, 1);
  });

  it("always launches when the report starts with new", async () => {
    state.open = [requestRow()];
    await postChat(message({ body: "@devbot new login button is still broken" }));
    assert.equal(state.listCalls, 0);
    assert.equal(state.routes.length, 0);
    assert.equal(state.created[0]!.prompt, "login button is still broken");

    state.created = [];
    await postChat(message({ body: "@devbot new" }));
    assert.equal(state.created[0]!.prompt, "new");
  });

  it("allows every sender when the allowlists are empty", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      ALLOWED_USER_IDS: "",
      ALLOWED_CONVERSATION_IDS: "",
      BOT_USER_ID: "",
    });
    await postChat(
      message({
        senderId: "someone-else",
        conversationId: "elsewhere",
        body: "@devbot fix login",
      }),
    );
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0]!.requestedBy, "someone-else");
  });

  it("keeps the HTTP ack when async processing throws", async () => {
    state.createError = new Error("insert failed");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const res = await postChat(message());
      assert.deepEqual(res.json, { ok: true });
    } finally {
      console.error = original;
    }
    assert.match(errors[0]!, /async processing failed/);
    assert.match(errors[0]!, /insert failed/);
  });
});

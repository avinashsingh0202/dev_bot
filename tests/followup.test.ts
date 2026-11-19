/**
 * Related-report delivery with db, chat, and Cursor mocked.
 */
import assert from "node:assert/strict";
import { mock, beforeEach, describe, it } from "node:test";
import type { RequestRow } from "../src/db.js";
import { requestRow } from "./helpers.js";

interface Post {
  channel: string;
  thread: string | null | undefined;
  text: string;
}

const state = {
  posts: [] as Post[],
  followups: [] as { agentId: string; text: string }[],
  updates: [] as { id: string; patch: { status?: string } }[],
  events: [] as { type: string; summary: string; payload?: { detail?: string } }[],
  links: [] as { chatChannel: string; chatThread: string; requestId: string }[],
  held: [] as { requestId: string; senderName: string; text: string }[],
  pending: [] as { id: string; sender_name: string; text: string }[],
  fresh: null as RequestRow | null,
  sendError: null as unknown,
  takes: 0,
  suppressTake: false,
};

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    enqueuePendingFollowup: async (input: {
      requestId: string;
      senderName: string;
      text: string;
    }) => {
      state.held.push(input);
      state.pending.push({
        id: String(state.pending.length + 1),
        sender_name: input.senderName,
        text: input.text,
      });
    },
    getRequestById: async () => state.fresh,
    linkRequestThread: async (input: {
      chatChannel: string;
      chatThread: string;
      requestId: string;
    }) => {
      state.links.push(input);
    },
    logEvent: async (input: {
      type: string;
      summary: string;
      payload?: { detail?: string };
    }) => {
      state.events.push(input);
    },
    takePendingFollowups: async () => {
      state.takes += 1;
      if (state.suppressTake) return [];
      return state.pending.splice(0);
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
      if (state.sendError) throw state.sendError;
      state.followups.push({ agentId, text });
    },
  },
});

const followup = await import("../src/followup.js");
const { routeRelatedReport, flushPendingFollowups } = followup;

function reset(): void {
  state.posts = [];
  state.followups = [];
  state.updates = [];
  state.events = [];
  state.links = [];
  state.held = [];
  state.pending = [];
  state.fresh = null;
  state.sendError = null;
  state.takes = 0;
  state.suppressTake = false;
}

async function route(
  request: RequestRow,
  overrides: { replyThread?: string; replyChannel?: string; text?: string } = {},
) {
  return routeRelatedReport({
    request,
    senderName: "Ada",
    text: overrides.text ?? "login still broken",
    replyChannel: overrides.replyChannel ?? "conv-reply",
    replyThread: overrides.replyThread ?? request.chat_thread ?? "thread-1",
    reason: "overlap",
  });
}

describe("routeRelatedReport", () => {
  beforeEach(() => reset());

  it("sends a follow-up on the open branch", async () => {
    const request = requestRow({ status: "pr_open" });
    assert.equal(await route(request), "sent");
    assert.equal(state.followups.length, 1);
    assert.equal(state.followups[0]!.agentId, "agent-1");
    assert.match(state.followups[0]!.text, /devbot\/11111111/);
    assert.match(state.followups[0]!.text, /Ada: login still broken/);
    assert.deepEqual(state.updates, [
      { id: request.id, patch: { status: "agent_running" } },
    ]);
    assert.equal(state.links.length, 0);
    assert.equal(state.posts.length, 1);
    assert.match(state.posts[0]!.text, /same agent/);
    assert.match(state.posts[0]!.text, /https:\/\/github.com\/acme\/app\/pull\/4/);
    assert.equal(state.events[0]!.type, "related_followup");
  });

  it("links a new thread and tells the original thread", async () => {
    const request = requestRow({ status: "ci_failed", pr_url: null, branch: null });
    assert.equal(await route(request, { replyThread: "other-thread" }), "sent");
    assert.deepEqual(state.links, [
      {
        chatChannel: "conv-reply",
        chatThread: "other-thread",
        requestId: request.id,
      },
    ]);
    assert.match(state.followups[0]!.text, /Stay on the current branch/);
    assert.match(state.posts[0]!.text, /the open fix/);
    assert.doesNotMatch(state.posts[0]!.text, /PR:/);
    assert.equal(state.posts[1]!.thread, request.chat_thread);
    assert.match(state.posts[1]!.text, /Related report added to this agent/);
  });

  it("reports the agent gone when it has no id or Cursor returns 404", async () => {
    const missing = requestRow({ status: "pr_open", agent_id: null });
    assert.equal(await route(missing), "agent_gone");
    assert.equal(state.followups.length, 0);
    assert.equal(state.posts.length, 0);

    state.sendError = new Error("Cursor followup failed: 404 Not Found");
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      assert.equal(await route(requestRow()), "agent_gone");
    } finally {
      console.warn = original;
    }
    assert.match(warnings[0]!, /is gone/);
    assert.equal(state.updates.length, 0);
    assert.equal(state.posts.length, 0);

    state.sendError = "agent expired";
    assert.equal(await route(requestRow()), "agent_gone");
  });

  it("queues a busy agent and rethrows other failures", async () => {
    state.sendError = new Error("Cursor followup failed: 409 currently running");
    const request = requestRow({ status: "pr_open" });
    assert.equal(await route(request), "queued");
    assert.deepEqual(state.held, [
      { requestId: request.id, senderName: "Ada", text: "login still broken" },
    ]);
    assert.deepEqual(state.updates, [
      { id: request.id, patch: { status: "pr_open" } },
    ]);
    assert.match(state.posts[0]!.text, /still working/);
    assert.equal(state.events[0]!.type, "related_queued");
    assert.match(state.events[0]!.payload?.detail ?? "", /409/);

    state.sendError = new Error("Cursor followup failed: 500 nope");
    state.posts = [];
    await assert.rejects(route(requestRow()), /500 nope/);
    assert.equal(state.posts.length, 0);
  });

  it("queues while the agent is running", async () => {
    const request = requestRow({ status: "agent_running" });
    state.fresh = request;
    assert.equal(
      await route(request, { replyThread: "other-thread" }),
      "queued",
    );
    assert.equal(state.followups.length, 0);
    assert.match(state.posts[0]!.text, /as soon as it is free/);
    assert.match(state.posts[1]!.text, /Related report queued for this agent/);
    assert.equal(state.events[0]!.type, "related_queued");
    assert.equal(state.links.length, 1);
  });

  it("flushes immediately when the agent finished before the hold", async () => {
    const request = requestRow({ status: "agent_running" });
    state.fresh = requestRow({ status: "pr_open" });
    assert.equal(await route(request), "sent");
    assert.equal(state.followups.length, 1);
    assert.match(state.posts[0]!.text, /Passed 1 related report to the same agent/);
    assert.equal(state.posts.length, 1);
    assert.equal(state.events.at(-1)!.type, "related_followup");
  });

  it("posts the sent summary on the reply thread when the flush wins", async () => {
    const request = requestRow({ status: "agent_running" });
    state.fresh = requestRow({ status: "ci_passed" });
    assert.equal(await route(request, { replyThread: "other-thread" }), "sent");
    assert.match(state.posts[0]!.text, /Passed 1 related report/);
    assert.equal(state.posts[0]!.thread, request.chat_thread);
    assert.match(state.posts[1]!.text, /same agent/);
    assert.equal(state.posts[1]!.thread, "other-thread");
  });

  it("stays queued when the flush has nothing to send", async () => {
    const request = requestRow({ status: "agent_running", branch: null });
    state.fresh = requestRow({ status: "pr_open", agent_id: null });
    assert.equal(await route(request), "queued");
    assert.equal(state.takes, 0);

    state.fresh = requestRow({ status: "pr_open" });
    state.suppressTake = true;
    assert.equal(await route(request), "queued");
    assert.match(state.posts.at(-1)!.text, /the open fix/);
  });
});

describe("flushPendingFollowups", () => {
  beforeEach(() => reset());

  it("does nothing without an agent or queued reports", async () => {
    assert.equal(
      await flushPendingFollowups(requestRow({ agent_id: null })),
      false,
    );
    assert.equal(state.takes, 0);
    assert.equal(await flushPendingFollowups(requestRow()), false);
    assert.equal(state.takes, 1);
    assert.equal(state.followups.length, 0);
  });

  it("sends every waiting report as one follow-up", async () => {
    state.pending = [
      { id: "1", sender_name: "Ada", text: "login still broken" },
      { id: "2", sender_name: "Bea", text: "checkout too" },
    ];
    const request = requestRow();
    assert.equal(await flushPendingFollowups(request), true);
    assert.match(state.followups[0]!.text, /Ada: login still broken/);
    assert.match(state.followups[0]!.text, /Bea: checkout too/);
    assert.deepEqual(state.updates, [
      { id: request.id, patch: { status: "agent_running" } },
    ]);
    assert.match(state.posts[0]!.text, /Passed 2 related reports/);
    assert.equal(state.events[0]!.type, "related_followup");
  });

  it("drops reports when the agent is gone", async () => {
    state.pending = [{ id: "1", sender_name: "Ada", text: "still broken" }];
    state.sendError = new Error("Cursor followup failed: 410 Gone");
    assert.equal(await flushPendingFollowups(requestRow()), false);
    assert.match(state.posts[0]!.text, /no longer available/);
    assert.equal(state.events[0]!.type, "related_dropped");
    assert.equal(state.held.length, 0);
    assert.equal(state.updates.length, 0);
  });

  it("puts reports back when the flush fails transiently", async () => {
    state.pending = [
      { id: "1", sender_name: "Ada", text: "one" },
      { id: "2", sender_name: "Bea", text: "two" },
    ];
    state.sendError = new Error("Cursor followup failed: 500 nope");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      assert.equal(await flushPendingFollowups(requestRow()), false);
    } finally {
      console.error = original;
    }
    assert.deepEqual(
      state.held.map((row) => row.text),
      ["one", "two"],
    );
    assert.equal(state.updates.length, 0);
    assert.match(errors[0]!, /flush failed/);
  });
});

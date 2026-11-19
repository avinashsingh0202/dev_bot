/**
 * Launch queue with db, chat, and Cursor mocked. No live agent calls.
 */
import assert from "node:assert/strict";
import { mock, beforeEach, describe, it } from "node:test";
import { buildAgentPrompt } from "../src/clients/cursor.js";
import { requestRow } from "./helpers.js";

interface LaunchInput {
  promptText: string;
  branchName: string;
}

const state = {
  running: [] as number[],
  launches: [] as LaunchInput[],
  posts: [] as { channel: string; thread: string | null | undefined; text: string }[],
  updates: [] as { id: string; patch: { status?: string; agent_id?: string; branch?: string } }[],
  events: [] as { type: string; summary: string; payload?: { url?: string } }[],
  failBranches: new Set<string>(),
  omitUrl: false,
  reenter: false,
  reentered: false,
};

let drainQueue: () => Promise<void> = async () => {};

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    countRunningAgents: async () => {
      if (state.reenter) {
        state.reenter = false;
        await drainQueue();
        state.reentered = true;
      }
      return state.running.shift() ?? 0;
    },
    logEvent: async (input: {
      type: string;
      summary: string;
      payload?: { url?: string };
    }) => {
      state.events.push(input);
    },
    updateRequest: async (
      id: string,
      patch: { status?: string; agent_id?: string; branch?: string },
    ) => {
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
    buildAgentPrompt,
    launchAgent: async (input: LaunchInput) => {
      state.launches.push(input);
      if (state.failBranches.has(input.branchName)) {
        throw new Error("nope");
      }
      if (state.omitUrl) return { id: "agent-1" };
      return {
        id: "agent-1",
        target: { url: "https://cursor.com/agents/agent-1" },
      };
    },
  },
});

const queue = await import("../src/queue.js");
drainQueue = queue.drainQueue;
const { enqueueOrLaunch, clearQueueForTests } = queue;

function reset(): void {
  clearQueueForTests();
  state.running = [];
  state.launches = [];
  state.posts = [];
  state.updates = [];
  state.events = [];
  state.failBranches = new Set();
  state.omitUrl = false;
  state.reenter = false;
  state.reentered = false;
}

describe("enqueueOrLaunch", () => {
  beforeEach(() => reset());

  it("starts an agent immediately when a slot is free", async () => {
    state.running = [0];
    const request = requestRow({
      id: "abcdefgh-1111-1111-1111-111111111111",
      branch: null,
      chat_thread: "thread-9",
    });
    await enqueueOrLaunch({ request, senderName: "Ada", text: "fix login" });

    assert.equal(state.launches.length, 1);
    assert.equal(state.launches[0]!.branchName, "devbot/abcdefgh");
    assert.match(state.launches[0]!.promptText, /Ada/);
    assert.match(state.launches[0]!.promptText, /fix login/);
    assert.deepEqual(state.updates[0], {
      id: request.id,
      patch: {
        agent_id: "agent-1",
        branch: "devbot/abcdefgh",
        status: "agent_running",
      },
    });
    assert.equal(
      state.posts[0]!.text,
      "Agent started on branch devbot/abcdefgh: https://cursor.com/agents/agent-1",
    );
    assert.equal(state.events[0]!.type, "agent_started");
    assert.equal(state.events[0]!.payload?.url, "https://cursor.com/agents/agent-1");
  });

  it("keeps an existing branch and omits the url when Cursor does not return one", async () => {
    state.running = [1];
    state.omitUrl = true;
    const request = requestRow({ branch: "devbot/custom", chat_thread: null });
    await enqueueOrLaunch({ request, senderName: "Bea", text: "rename the app" });
    assert.equal(state.launches[0]!.branchName, "devbot/custom");
    assert.equal(state.posts[0]!.thread, null);
    assert.equal(state.posts[0]!.text, "Agent started on branch devbot/custom");
    assert.equal(state.events[0]!.payload?.url, undefined);
  });

  it("lets a launch failure escape when the request was not queued", async () => {
    state.running = [0];
    const request = requestRow({
      id: "abcdefgh-1111-1111-1111-111111111111",
      branch: null,
    });
    state.failBranches.add("devbot/abcdefgh");
    await assert.rejects(
      enqueueOrLaunch({ request, senderName: "Ada", text: "fix login" }),
      /nope/,
    );
    assert.equal(state.updates.length, 0);
    assert.equal(state.posts.length, 0);
  });

  it("queues above the cap and starts FIFO when a slot frees", async () => {
    state.running = [3, 3, 0, 3, 0];
    const first = requestRow({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      branch: "devbot/aaaaaaaa",
    });
    const second = requestRow({
      id: "bbbbbbbb-1111-1111-1111-111111111111",
      branch: "devbot/bbbbbbbb",
    });
    await enqueueOrLaunch({ request: first, senderName: "Ada", text: "one" });
    await enqueueOrLaunch({ request: second, senderName: "Bea", text: "two" });
    assert.equal(state.launches.length, 0);
    assert.deepEqual(
      state.posts.map((post) => post.text),
      ["Queued", "Queued"],
    );
    assert.equal(state.events[0]!.type, "queued");
    assert.match(state.events[0]!.summary, /waiting for an agent slot/);

    await drainQueue();
    assert.deepEqual(
      state.launches.map((launch) => launch.branchName),
      ["devbot/aaaaaaaa"],
    );

    await drainQueue();
    assert.deepEqual(
      state.launches.map((launch) => launch.branchName),
      ["devbot/aaaaaaaa", "devbot/bbbbbbbb"],
    );
  });

  it("marks a queued launch failure and continues with the next item", async () => {
    state.running = [3, 3, 0, 0];
    const first = requestRow({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      branch: "devbot/aaaaaaaa",
      chat_channel: "conv-a",
      chat_thread: "thread-a",
    });
    const second = requestRow({
      id: "bbbbbbbb-1111-1111-1111-111111111111",
      branch: "devbot/bbbbbbbb",
    });
    state.failBranches.add("devbot/aaaaaaaa");
    await enqueueOrLaunch({ request: first, senderName: "Ada", text: "one" });
    await enqueueOrLaunch({ request: second, senderName: "Bea", text: "two" });

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await drainQueue();
    } finally {
      console.error = original;
    }

    assert.equal(state.updates[0]!.patch.status, "agent_error");
    assert.equal(state.updates[0]!.id, first.id);
    assert.match(state.posts.at(-2)!.text, /Failed to start agent: Error: nope/);
    assert.equal(state.events.at(-2)!.type, "agent_error");
    assert.equal(state.launches.at(-1)!.branchName, "devbot/bbbbbbbb");
    assert.equal(state.updates.at(-1)!.patch.status, "agent_running");
    assert.match(String(errors[0]?.[0]), /failed to start queued agent/);
  });

  it("ignores a nested drain while one is already running", async () => {
    state.running = [3, 0];
    const request = requestRow({ branch: "devbot/custom" });
    await enqueueOrLaunch({ request, senderName: "Ada", text: "one" });
    state.reenter = true;
    await drainQueue();
    assert.equal(state.reentered, true);
    assert.equal(state.launches.length, 1);
  });
});

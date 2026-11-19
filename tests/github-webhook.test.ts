/**
 * GitHub PR and workflow webhooks with db, chat, and Cursor mocked.
 * decideCiRetry stays the real helper.
 */
import assert from "node:assert/strict";
import express from "express";
import { mock, afterEach, beforeEach, describe, it } from "node:test";
import { decideCiRetry } from "../src/clients/github.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { requestRow, requestJson, signBody, testEnv, withServer } from "./helpers.js";

const state = {
  request: null as ReturnType<typeof requestRow> | null,
  claimNew: true,
  claims: [] as string[],
  finds: [] as string[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  posts: [] as { text: string }[],
  events: [] as { type: string; summary: string; payload?: Record<string, unknown> }[],
  followups: [] as { agentId: string; text: string }[],
  logRuns: [] as number[],
  logs: "tail of the failed job",
  logError: null as Error | null,
};

mock.module("../src/db.ts", {
  cache: true,
  namedExports: {
    claimWebhookDelivery: async (id: string) => {
      state.claims.push(id);
      return state.claimNew;
    },
    findRequestByBranch: async (branch: string) => {
      state.finds.push(branch);
      return state.request;
    },
    logEvent: async (input: {
      type: string;
      summary: string;
      payload?: Record<string, unknown>;
    }) => {
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

mock.module("../src/clients/cursor.ts", {
  cache: true,
  namedExports: {
    sendFollowup: async (agentId: string, text: string) => {
      state.followups.push({ agentId, text });
    },
  },
});

mock.module("../src/clients/github.ts", {
  cache: true,
  namedExports: {
    decideCiRetry,
    collectFailedJobLogs: async (runId: number) => {
      state.logRuns.push(runId);
      if (state.logError) throw state.logError;
      return state.logs;
    },
  },
});

const { createGitHubRouter } = await import("../src/routes/github.js");
const app = express();
app.use(createGitHubRouter());

function reset(): void {
  state.request = requestRow({ ci_attempts: 0 });
  state.claimNew = true;
  state.claims = [];
  state.finds = [];
  state.updates = [];
  state.posts = [];
  state.events = [];
  state.followups = [];
  state.logRuns = [];
  state.logs = "tail of the failed job";
  state.logError = null;
  resetConfigCache();
  loadConfig({ ...testEnv, MAX_CI_RETRIES: "2" });
}

async function postGithub(
  event: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const raw = JSON.stringify(body);
  let result = { status: 0, json: undefined as unknown };
  await withServer(app, async (base) => {
    result = await requestJson(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": signBody("gh-secret", raw),
        ...headers,
      },
      body: raw,
    });
  });
  return result;
}

describe("GitHub workflow_run webhook", () => {
  beforeEach(() => reset());
  afterEach(() => resetConfigCache());

  it("marks CI passed", async () => {
    const res = await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 55,
        conclusion: "success",
        head_branch: "devbot/11111111",
        html_url: "https://github.com/acme/app/actions/runs/55",
      },
    });
    assert.deepEqual(res.json, { ok: true });
    assert.deepEqual(state.finds, ["devbot/11111111"]);
    assert.deepEqual(state.updates[0]!.patch, { status: "ci_passed" });
    assert.equal(state.posts[0]!.text, "CI passed, ready for review");
    assert.equal(state.events[0]!.type, "ci_passed");
    assert.equal(state.events[0]!.payload?.runId, 55);
  });

  it("sends the failed log tail and retries while attempts remain", async () => {
    state.request = requestRow({ ci_attempts: 1 });
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 55,
        conclusion: "failure",
        head_branch: "devbot/11111111",
        html_url: "https://github.com/acme/app/actions/runs/55",
      },
    });
    assert.deepEqual(state.logRuns, [55]);
    assert.deepEqual(state.updates.map((update) => update.patch), [
      { status: "ci_failed", ci_attempts: 2 },
      { status: "agent_running" },
    ]);
    assert.equal(state.followups[0]!.agentId, "agent-1");
    assert.match(state.followups[0]!.text, /tail of the failed job/);
    assert.equal(state.posts[0]!.text, "CI failed, agent is fixing (2/2)");
    assert.equal(state.events[0]!.type, "ci_retry");
  });

  it("still retries when the log fetch fails or the agent id is missing", async () => {
    state.logError = new Error("logs down");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await postGithub("workflow_run", {
        action: "completed",
        workflow_run: {
          id: 7,
          conclusion: "failure",
          head_branch: "devbot/11111111",
        },
      });
    } finally {
      console.error = original;
    }
    assert.match(errors[0]!, /log fetch failed/);
    assert.match(state.followups[0]!.text, /\(could not fetch logs\)/);

    state.request = requestRow({ agent_id: null, ci_attempts: 0 });
    state.followups = [];
    state.logError = null;
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 8,
        conclusion: "failure",
        head_branch: "devbot/11111111",
      },
    });
    assert.equal(state.followups.length, 0);
    assert.equal(state.updates.at(-1)!.patch.status, "agent_running");
  });

  it("gives up at the retry cap, including when retries are disabled", async () => {
    state.request = requestRow({ ci_attempts: 2 });
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 55,
        conclusion: "failure",
        head_branch: "devbot/11111111",
        html_url: "https://github.com/acme/app/actions/runs/55",
      },
    });
    assert.equal(state.followups.length, 0);
    assert.deepEqual(state.updates[0]!.patch, { status: "gave_up" });
    assert.match(state.posts[0]!.text, /needs a human/);
    assert.match(state.posts[0]!.text, /actions\/runs\/55/);
    assert.equal(state.events[0]!.type, "gave_up");

    state.updates = [];
    state.posts = [];
    state.request = requestRow({ ci_attempts: 2 });
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 56,
        conclusion: "failure",
        head_branch: "devbot/11111111",
      },
    });
    assert.equal(state.posts[0]!.text, "CI still failing, needs a human");

    resetConfigCache();
    loadConfig({ ...testEnv, MAX_CI_RETRIES: "0" });
    state.updates = [];
    state.request = requestRow({ ci_attempts: 0 });
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 57,
        conclusion: "failure",
        head_branch: "devbot/11111111",
        html_url: "https://github.com/acme/app/actions/runs/57",
      },
    });
    assert.deepEqual(state.updates[0]!.patch, { status: "gave_up" });
  });

  it("ignores a cancelled run and a branch with no request", async () => {
    await postGithub("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 1,
        conclusion: "cancelled",
        head_branch: "devbot/11111111",
      },
    });
    assert.deepEqual(state.finds, ["devbot/11111111"]);
    assert.equal(state.updates.length, 0);

    state.request = null;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const res = await postGithub("workflow_run", {
        action: "completed",
        workflow_run: {
          id: 2,
          conclusion: "success",
          head_branch: "devbot/missing",
        },
      });
      assert.deepEqual(res.json, { ok: true });
    } finally {
      console.warn = original;
    }
    assert.match(warnings[0]!, /no request for branch devbot\/missing/);
    assert.equal(state.updates.length, 0);
  });

  it("dedupes a delivery id", async () => {
    state.claimNew = false;
    const res = await postGithub(
      "workflow_run",
      {
        action: "completed",
        workflow_run: {
          conclusion: "success",
          head_branch: "devbot/11111111",
        },
      },
      { "x-github-delivery": "abc" },
    );
    assert.deepEqual(res.json, { ok: true, deduped: true });
    assert.deepEqual(state.claims, ["github:abc"]);
    assert.equal(state.finds.length, 0);
  });
});

describe("GitHub pull_request webhook", () => {
  beforeEach(() => reset());
  afterEach(() => resetConfigCache());

  it("records a merge, falling back when the merger is missing", async () => {
    await postGithub("pull_request", {
      action: "closed",
      pull_request: {
        merged: true,
        html_url: "https://github.com/acme/app/pull/4",
        number: 4,
        head: { ref: "devbot/11111111" },
        user: { login: "ada" },
        merged_by: { login: "grace" },
      },
    });
    assert.deepEqual(state.updates[0]!.patch, {
      status: "merged",
      pr_url: "https://github.com/acme/app/pull/4",
      pr_number: 4,
    });
    assert.equal(state.posts[0]!.text, "Merged by grace");
    assert.equal(state.events[0]!.type, "merged");

    state.updates = [];
    state.posts = [];
    await postGithub("pull_request", {
      action: "closed",
      pull_request: {
        merged: true,
        head: { ref: "devbot/11111111" },
        user: { login: "ada" },
      },
    });
    assert.equal(state.posts[0]!.text, "Merged by ada");
    assert.equal(state.updates[0]!.patch.pr_url, state.request!.pr_url);
    assert.equal(state.updates[0]!.patch.pr_number, state.request!.pr_number);

    state.posts = [];
    state.request = requestRow({
      pr_url: null,
      pr_number: null,
    });
    await postGithub("pull_request", {
      action: "closed",
      pull_request: {
        merged: true,
        head: { ref: "devbot/11111111" },
      },
    });
    assert.equal(state.posts[0]!.text, "Merged by someone");
  });

  it("records a close without a merge", async () => {
    await postGithub("pull_request", {
      action: "closed",
      pull_request: {
        merged: false,
        html_url: "https://github.com/acme/app/pull/4",
        number: 4,
        head: { ref: "devbot/11111111" },
      },
    });
    assert.deepEqual(state.updates[0]!.patch, {
      status: "closed",
      pr_url: "https://github.com/acme/app/pull/4",
      pr_number: 4,
    });
    assert.equal(state.posts[0]!.text, "PR closed without merging");
    assert.equal(state.events[0]!.type, "closed");
  });

  it("warns when the closed PR has no request", async () => {
    state.request = null;
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await postGithub("pull_request", {
        action: "closed",
        pull_request: {
          merged: false,
          head: { ref: "devbot/missing" },
        },
      });
    } finally {
      console.warn = original;
    }
    assert.match(warnings[0]!, /no request for PR branch devbot\/missing/);
    assert.equal(state.updates.length, 0);
  });
});

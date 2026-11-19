import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideCiRetry,
  lastLines,
  planFinishedPullRequest,
  pullRequestBody,
  pullRequestTitle,
} from "../src/clients/github.js";

describe("decideCiRetry", () => {
  it("retries while attempts are below max", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 0, maxRetries: 2 }), {
      shouldRetry: true,
      nextAttempts: 1,
    });
    assert.deepEqual(decideCiRetry({ ciAttempts: 1, maxRetries: 2 }), {
      shouldRetry: true,
      nextAttempts: 2,
    });
  });

  it("gives up once attempts reach max", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 2, maxRetries: 2 }), {
      shouldRetry: false,
      nextAttempts: 3,
    });
  });

  it("respects MAX_CI_RETRIES=0 (no auto fix)", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 0, maxRetries: 0 }), {
      shouldRetry: false,
      nextAttempts: 1,
    });
  });
});

describe("planFinishedPullRequest", () => {
  it("keeps a PR URL Cursor already returned", () => {
    assert.deepEqual(
      planFinishedPullRequest({
        prUrl: "https://github.com/org/repo/pull/4",
        branchName: "devbot/abc",
      }),
      { action: "record_pr", prUrl: "https://github.com/org/repo/pull/4" },
    );
  });

  it("opens a PR when the branch exists and Cursor omitted prUrl", () => {
    assert.deepEqual(
      planFinishedPullRequest({ prUrl: "  ", branchName: "devbot/abc" }),
      { action: "open_pr", branch: "devbot/abc" },
    );
  });

  it("asks for clarification when the agent finished with no branch", () => {
    assert.deepEqual(planFinishedPullRequest({ prUrl: null, branchName: "" }), {
      action: "clarify",
    });
  });
});

describe("pull request text", () => {
  it("clips a long chat prompt into a title", () => {
    const title = pullRequestTitle("x".repeat(80));
    assert.equal(title.startsWith("DevBot: "), true);
    assert.equal(title.length, "DevBot: ".length + 72);
    assert.equal(title.endsWith("..."), true);
  });

  it("collapses whitespace and falls back when the prompt is blank", () => {
    assert.equal(pullRequestTitle("  fix\nlogin  "), "DevBot: fix login");
    assert.equal(pullRequestTitle("   "), "DevBot: change");
    assert.equal(pullRequestTitle("x".repeat(72)), `DevBot: ${"x".repeat(72)}`);
    assert.equal(
      pullRequestTitle("x".repeat(73)),
      `DevBot: ${"x".repeat(69)}...`,
    );
  });

  it("puts the chat prompt and agent link in the body", () => {
    const body = pullRequestBody({
      prompt: "change the app name to HOA",
      summary: "Renamed launcher labels.",
      agentUrl: "https://cursor.com/agents/bc-1",
    });
    assert.match(body, /Opened by DevBot/);
    assert.match(body, /Renamed launcher labels/);
    assert.match(body, /change the app name to HOA/);
    assert.match(body, /https:\/\/cursor.com\/agents\/bc-1/);
  });

  it("omits a blank summary and agent link", () => {
    assert.equal(
      pullRequestBody({ prompt: "  ", summary: "  ", agentUrl: " " }),
      "Opened by DevBot.\n\nRequested in chat: (empty)",
    );
  });
});

describe("lastLines", () => {
  it("keeps the last N lines for CI log tails", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const tail = lastLines(text, 150);
    const lines = tail.split("\n");
    assert.equal(lines.length, 150);
    assert.equal(lines[0], "line-51");
    assert.equal(lines[149], "line-200");
  });

  it("returns the full text when shorter than the limit", () => {
    assert.equal(lastLines("a\nb\nc", 150), "a\nb\nc");
  });

  it("normalizes CRLF and keeps a short log intact", () => {
    assert.equal(lastLines("a\r\nb\r\nc", 2), "b\nc");
    assert.equal(lastLines("a\nb", 2), "a\nb");
    assert.equal(lastLines("", 5), "");
  });
});

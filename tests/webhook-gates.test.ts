/**
 * Webhook edges that return before any database call.
 */
import assert from "node:assert/strict";
import express from "express";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { createChatRouter } from "../src/routes/chat.js";
import { createCursorRouter } from "../src/routes/cursor.js";
import { createGitHubRouter } from "../src/routes/github.js";
import { requestJson, signBody, testEnv, withServer } from "./helpers.js";

const cursorSecret = "x".repeat(32);
const githubSecret = "gh-secret";

async function postRaw(
  app: express.Express,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  let result = { status: 0, json: undefined as unknown };
  await withServer(app, async (base) => {
    result = await requestJson(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  });
  return result;
}

describe("webhook gates", () => {
  const cursorApp = express();
  cursorApp.use(createCursorRouter());
  const githubApp = express();
  githubApp.use(createGitHubRouter());
  const chatApp = express();
  chatApp.use(express.json());
  chatApp.use(createChatRouter());

  beforeEach(() => {
    resetConfigCache();
    loadConfig({ ...testEnv });
  });

  afterEach(() => resetConfigCache());

  it("rejects a missing or invalid Cursor signature", async () => {
    const body = JSON.stringify({ event: "heartbeat" });
    const missing = await postRaw(cursorApp, "/webhooks/cursor", body, {});
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.json, { ok: false, error: "invalid_signature" });

    const bad = await postRaw(cursorApp, "/webhooks/cursor", body, {
      "x-webhook-signature": "sha256=deadbeef",
    });
    assert.equal(bad.status, 401);
  });

  it("acks bad Cursor JSON and ignores events that are not status changes", async () => {
    const broken = "{";
    const badJson = await postRaw(cursorApp, "/webhooks/cursor", broken, {
      "x-webhook-signature": signBody(cursorSecret, broken),
    });
    assert.equal(badJson.status, 200);
    assert.deepEqual(badJson.json, { ok: false, error: "bad_json" });

    const heartbeat = JSON.stringify({ event: "heartbeat" });
    const ignored = await postRaw(cursorApp, "/webhooks/cursor", heartbeat, {
      "x-webhook-signature": signBody(cursorSecret, heartbeat),
    });
    assert.deepEqual(ignored, { status: 200, json: { ok: true } });

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const missingId = JSON.stringify({ event: "statusChange", status: "FINISHED" });
      const acked = await postRaw(cursorApp, "/webhooks/cursor", missingId, {
        "x-webhook-signature": signBody(cursorSecret, missingId),
      });
      assert.deepEqual(acked, { status: 200, json: { ok: true } });
    } finally {
      console.warn = original;
    }
    assert.match(warnings[0]!, /missing agent id/);
  });

  it("rejects a bad GitHub signature and ignores events that are not ours", async () => {
    const body = JSON.stringify({ action: "opened" });
    const bad = await postRaw(githubApp, "/webhooks/github", body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": "sha256=nope",
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.json, { ok: false, error: "invalid_signature" });

    const broken = "not-json";
    const badJson = await postRaw(githubApp, "/webhooks/github", broken, {
      "x-github-event": "push",
      "x-hub-signature-256": signBody(githubSecret, broken),
    });
    assert.deepEqual(badJson, { status: 200, json: { ok: false, error: "bad_json" } });

    const unknown = JSON.stringify({ action: "opened" });
    const ignored = await postRaw(githubApp, "/webhooks/github", unknown, {
      "x-hub-signature-256": signBody(githubSecret, unknown),
    });
    assert.deepEqual(ignored, { status: 200, json: { ok: true } });

    const running = JSON.stringify({
      action: "in_progress",
      workflow_run: { head_branch: "devbot/abc", conclusion: "success" },
    });
    const notDone = await postRaw(githubApp, "/webhooks/github", running, {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signBody(githubSecret, running),
    });
    assert.deepEqual(notDone, { status: 200, json: { ok: true } });

    const otherBranch = JSON.stringify({
      action: "completed",
      workflow_run: { id: 1, head_branch: "feature/x", conclusion: "failure" },
    });
    const skippedRun = await postRaw(githubApp, "/webhooks/github", otherBranch, {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signBody(githubSecret, otherBranch),
    });
    assert.deepEqual(skippedRun, { status: 200, json: { ok: true } });

    const opened = JSON.stringify({
      action: "opened",
      pull_request: { head: { ref: "devbot/abc" } },
    });
    const skippedPr = await postRaw(githubApp, "/webhooks/github", opened, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signBody(githubSecret, opened),
    });
    assert.deepEqual(skippedPr, { status: 200, json: { ok: true } });

    const foreign = JSON.stringify({
      action: "closed",
      pull_request: { merged: true, head: { ref: "feature/x" } },
    });
    const skippedClose = await postRaw(githubApp, "/webhooks/github", foreign, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signBody(githubSecret, foreign),
    });
    assert.deepEqual(skippedClose, { status: 200, json: { ok: true } });
  });

  it("acks a chat payload that cannot be parsed", async () => {
    const result = await postRaw(chatApp, "/webhooks/chat", "{}", {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: false, error: "bad_payload" });
  });
});

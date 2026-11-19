/**
 * App wiring: health, raw-body signatures, and the chat JSON parser.
 * These paths return before touching Postgres.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { requestJson, signBody, testEnv, withServer } from "./helpers.js";

describe("createApp", () => {
  const app = createApp();

  beforeEach(() => {
    resetConfigCache();
    loadConfig({ ...testEnv });
  });

  afterEach(() => resetConfigCache());

  it("serves liveness", async () => {
    await withServer(app, async (base) => {
      const res = await requestJson(`${base}/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true, service: "devbot" });
    });
  });

  it("verifies Cursor and GitHub signatures against the raw body", async () => {
    await withServer(app, async (base) => {
      const cursorBody = JSON.stringify({ event: "heartbeat" });
      const cursorOk = await requestJson(`${base}/webhooks/cursor`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signBody("x".repeat(32), cursorBody),
        },
        body: cursorBody,
      });
      assert.equal(cursorOk.status, 200);
      assert.deepEqual(cursorOk.json, { ok: true });

      const cursorBad = await requestJson(`${base}/webhooks/cursor`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": "sha256=deadbeef",
        },
        body: cursorBody,
      });
      assert.equal(cursorBad.status, 401);

      const githubBody = JSON.stringify({ zen: "keep it small" });
      const githubOk = await requestJson(`${base}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-hub-signature-256": signBody("gh-secret", githubBody),
        },
        body: githubBody,
      });
      assert.equal(githubOk.status, 200);
      assert.deepEqual(githubOk.json, { ok: true });

      const githubBad = await requestJson(`${base}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: githubBody,
      });
      assert.equal(githubBad.status, 401);
    });
  });

  it("parses chat JSON and rejects a payload without ids", async () => {
    await withServer(app, async (base) => {
      const res = await requestJson(`${base}/webhooks/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: false, error: "bad_payload" });
    });
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { buildAgentPrompt, launchAgent, sendFollowup } from "../src/clients/cursor.js";
import {
  installFetch,
  jsonResponse,
  testEnv,
  textResponse,
  type RecordedRequest,
} from "./helpers.js";

describe("buildAgentPrompt", () => {
  it("includes the reporter, the report, and the finish instructions", () => {
    const prompt = buildAgentPrompt("Ada", "login button is broken");
    assert.match(prompt, /Ada/);
    assert.match(prompt, /login button is broken/);
    assert.match(prompt, /smallest fix/);
    assert.match(prompt, /too vague to act on/);
  });
});

describe("Cursor API client", () => {
  let requests: RecordedRequest[];
  let restore: () => void;
  let handler: (req: RecordedRequest) => Response | Promise<Response>;

  beforeEach(() => {
    resetConfigCache();
    loadConfig({ ...testEnv });
    handler = () => jsonResponse(200, { id: "agent-1" });
    const installed = installFetch((req) => handler(req));
    requests = installed.requests;
    restore = installed.restore;
  });

  afterEach(() => {
    restore();
    resetConfigCache();
  });

  it("launches an agent with basic auth, webhook, and no model when unset", async () => {
    const result = await launchAgent({
      promptText: "fix login",
      branchName: "devbot/abc",
    });
    assert.deepEqual(result, { id: "agent-1" });
    assert.equal(requests.length, 1);
    const req = requests[0]!;
    assert.equal(req.url, "https://api.cursor.com/v0/agents");
    assert.equal(req.method, "POST");
    assert.equal(
      req.headers.authorization,
      `Basic ${Buffer.from("cursor-key:").toString("base64")}`,
    );
    assert.equal(req.headers["content-type"], "application/json");
    const body = JSON.parse(req.body ?? "") as Record<string, unknown>;
    assert.deepEqual(body.prompt, { text: "fix login" });
    assert.deepEqual(body.source, {
      repository: "https://github.com/acme/app",
      ref: "main",
    });
    assert.deepEqual(body.target, {
      autoCreatePr: true,
      branchName: "devbot/abc",
    });
    assert.deepEqual(body.webhook, {
      url: "https://hooks.example.com/webhooks/cursor",
      secret: "x".repeat(32),
    });
    assert.equal("model" in body, false);
  });

  it("strips a trailing slash and sends CURSOR_MODEL when set", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      PUBLIC_BASE_URL: "https://hooks.example.com/base/",
      CURSOR_MODEL: "composer-2",
      DEFAULT_REF: "develop",
    });
    await launchAgent({ promptText: "p", branchName: "devbot/abc" });
    const body = JSON.parse(requests[0]!.body ?? "") as {
      model?: string;
      source: { ref: string };
      webhook: { url: string };
    };
    assert.equal(body.model, "composer-2");
    assert.equal(body.source.ref, "develop");
    assert.equal(
      body.webhook.url,
      "https://hooks.example.com/base/webhooks/cursor",
    );
  });

  it("includes the Cursor status and body when launch fails", async () => {
    handler = () => textResponse(401, "bad key", "Unauthorized");
    await assert.rejects(
      launchAgent({ promptText: "p", branchName: "b" }),
      /Cursor launchAgent failed: 401 Unauthorized bad key/,
    );
  });

  it("still throws when the error body cannot be read", async () => {
    handler = () =>
      ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => {
          throw new Error("socket");
        },
      }) as unknown as Response;
    await assert.rejects(
      launchAgent({ promptText: "p", branchName: "b" }),
      /Cursor launchAgent failed: 502 Bad Gateway$/,
    );
  });

  it("propagates a network failure", async () => {
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    await assert.rejects(
      launchAgent({ promptText: "p", branchName: "b" }),
      /offline/,
    );
  });

  it("posts a follow-up to that agent and surfaces API errors", async () => {
    await sendFollowup("agent-1", "please retry");
    assert.equal(
      requests[0]!.url,
      "https://api.cursor.com/v0/agents/agent-1/followup",
    );
    assert.deepEqual(JSON.parse(requests[0]!.body ?? ""), {
      prompt: { text: "please retry" },
    });

    handler = () => textResponse(409, "currently running", "Conflict");
    await assert.rejects(
      sendFollowup("agent-1", "again"),
      /Cursor followup failed: 409 Conflict currently running/,
    );
  });
});

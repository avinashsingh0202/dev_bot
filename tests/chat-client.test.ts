import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { postMessage } from "../src/clients/chat.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import {
  installFetch,
  jsonResponse,
  testEnv,
  textResponse,
  type RecordedRequest,
} from "./helpers.js";

describe("postMessage", () => {
  let requests: RecordedRequest[];
  let restore: () => void;
  let handler: (req: RecordedRequest) => Response | Promise<Response>;

  beforeEach(() => {
    resetConfigCache();
    loadConfig({ ...testEnv });
    handler = () => jsonResponse(200, { ok: true });
    const installed = installFetch((req) => handler(req));
    requests = installed.requests;
    restore = installed.restore;
  });

  afterEach(() => {
    restore();
    resetConfigCache();
  });

  it("logs and skips when outbound chat is not configured", async () => {
    const logs: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      await postMessage("conv-1", "thread-1", "On it");
    } finally {
      console.log = original;
    }
    assert.equal(requests.length, 0);
    assert.match(String(logs[0]?.[0]), /outbound skipped/);
    assert.deepEqual(logs[0]?.[1], {
      channelId: "conv-1",
      threadId: "thread-1",
      text: "On it",
    });
  });

  it("posts a thread reply when url and token are set", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      CHAT_POST_URL: "https://chat.example/send",
      CHAT_BOT_TOKEN: "bot-token",
    });
    await postMessage("conv-1", "thread-1", "On it");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://chat.example/send");
    assert.equal(requests[0]!.method, "POST");
    assert.equal(requests[0]!.headers.authorization, "Bearer bot-token");
    assert.equal(requests[0]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(requests[0]!.body ?? ""), {
      conversationId: "conv-1",
      body: "On it",
      parentMessageId: "thread-1",
    });
  });

  it("omits parentMessageId when there is no thread", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      CHAT_POST_URL: "https://chat.example/send",
      CHAT_BOT_TOKEN: "bot-token",
    });
    await postMessage("conv-1", null, "hello");
    await postMessage("conv-1", "", "hello again");
    assert.deepEqual(JSON.parse(requests[0]!.body ?? ""), {
      conversationId: "conv-1",
      body: "hello",
    });
    assert.deepEqual(JSON.parse(requests[1]!.body ?? ""), {
      conversationId: "conv-1",
      body: "hello again",
    });
  });

  it("throws the status and body when the send API fails", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      CHAT_POST_URL: "https://chat.example/send",
      CHAT_BOT_TOKEN: "bot-token",
    });
    handler = () => textResponse(403, "no", "Forbidden");
    await assert.rejects(
      postMessage("conv-1", "thread-1", "On it"),
      /chat postMessage failed: 403 Forbidden no/,
    );

    handler = () =>
      ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => {
          throw new Error("reset");
        },
      }) as unknown as Response;
    await assert.rejects(
      postMessage("conv-1", "thread-1", "On it"),
      /chat postMessage failed: 500 Server Error$/,
    );
  });
});

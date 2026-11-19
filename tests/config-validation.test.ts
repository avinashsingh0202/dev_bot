/**
 * Failure and parsing cases for loadConfig.
 * Optional-env success cases live in config-optional-chat.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  isLocalPublicBaseUrl,
  loadConfig,
  resetConfigCache,
  warnLocalPublicBaseUrl,
} from "../src/config.js";
import { testEnv } from "./helpers.js";

function requiredEnv(): NodeJS.ProcessEnv {
  return { ...testEnv };
}

describe("loadConfig validation", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  it("applies defaults for port, ref, retries, and parses allowlists", () => {
    const env = requiredEnv();
    delete env.PORT;
    delete env.DEFAULT_REF;
    delete env.MAX_CI_RETRIES;
    env.ALLOWED_USER_IDS = " ada , bob , , ada ";
    env.ALLOWED_CONVERSATION_IDS = " conv-1, conv-2 ";
    env.CHAT_POST_URL = "https://chat.example/send";
    env.CHAT_BOT_TOKEN = "";

    const config = loadConfig(env);
    assert.equal(config.PORT, 3000);
    assert.equal(config.DEFAULT_REF, "main");
    assert.equal(config.MAX_CI_RETRIES, 2);
    assert.equal(config.chatOutboundEnabled, false);
    assert.deepEqual([...config.allowedUserIds], ["ada", "bob"]);
    assert.deepEqual([...config.allowedConversationIds], ["conv-1", "conv-2"]);
    assert.equal(loadConfig(env), config);
  });

  it("coerces numeric env and enables outbound only when both chat values are set", () => {
    const config = loadConfig({
      ...requiredEnv(),
      PORT: "4000",
      MAX_CI_RETRIES: "0",
      CHAT_BOT_TOKEN: "token",
      CHAT_POST_URL: "",
    });
    assert.equal(config.PORT, 4000);
    assert.equal(config.MAX_CI_RETRIES, 0);
    assert.equal(config.chatOutboundEnabled, false);

    resetConfigCache();
    const enabled = loadConfig({
      ...requiredEnv(),
      CHAT_POST_URL: "https://chat.example/send",
      CHAT_BOT_TOKEN: "token",
    });
    assert.equal(enabled.chatOutboundEnabled, true);
  });

  it("treats a whitespace PUBLIC_BASE_URL as the localhost default", () => {
    const config = loadConfig({ ...requiredEnv(), PUBLIC_BASE_URL: "   " });
    assert.equal(config.PUBLIC_BASE_URL, "http://localhost:3000");
    assert.equal(isLocalPublicBaseUrl(config.PUBLIC_BASE_URL), true);
  });

  it("does not cache a failed parse", () => {
    const env = requiredEnv();
    delete env.DATABASE_URL;
    delete env.GITHUB_TOKEN;
    assert.throws(() => loadConfig(env), /DATABASE_URL/);
    assert.throws(() => loadConfig(env), /GITHUB_TOKEN/);

    const config = loadConfig(requiredEnv());
    assert.equal(config.DEFAULT_REPO, "https://github.com/acme/app");
  });

  it("rejects secrets, urls, and numeric bounds that cannot boot", () => {
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnv(),
          CURSOR_WEBHOOK_SECRET: "too-short",
        }),
      /CURSOR_WEBHOOK_SECRET/,
    );
    resetConfigCache();
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnv(),
          DEFAULT_REPO: "not-a-url",
        }),
      /DEFAULT_REPO/,
    );
    resetConfigCache();
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnv(),
          CHAT_POST_URL: "not-a-url",
        }),
      /CHAT_POST_URL: must be empty or a valid URL/,
    );
    resetConfigCache();
    assert.throws(
      () =>
        loadConfig({
          ...requiredEnv(),
          PUBLIC_BASE_URL: "http://",
        }),
      /PUBLIC_BASE_URL/,
    );
    resetConfigCache();
    assert.throws(
      () => loadConfig({ ...requiredEnv(), PORT: "0" }),
      /PORT/,
    );
    resetConfigCache();
    assert.throws(
      () => loadConfig({ ...requiredEnv(), MAX_CI_RETRIES: "-1" }),
      /MAX_CI_RETRIES/,
    );
    resetConfigCache();
    assert.throws(
      () => loadConfig({ ...requiredEnv(), PORT: "nope" }),
      /PORT/,
    );
  });
});

describe("isLocalPublicBaseUrl", () => {
  it("recognises loopback hosts and unparseable values", () => {
    assert.equal(isLocalPublicBaseUrl("http://localhost:3000"), true);
    assert.equal(isLocalPublicBaseUrl("http://LOCALHOST:3000"), true);
    assert.equal(isLocalPublicBaseUrl("http://127.0.0.1:9"), true);
    assert.equal(isLocalPublicBaseUrl("http://[::1]/hooks"), true);
    assert.equal(isLocalPublicBaseUrl("not a url"), true);
    assert.equal(isLocalPublicBaseUrl("https://example.com"), false);
    assert.equal(isLocalPublicBaseUrl("https://example.com.localhost"), false);
  });

  it("warns only for a local base url", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      warnLocalPublicBaseUrl("https://hooks.example.com");
      assert.equal(warnings.length, 0);
      warnLocalPublicBaseUrl("http://127.0.0.1:3000");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /127\.0\.0\.1:3000/);
    } finally {
      console.warn = original;
    }
  });
});

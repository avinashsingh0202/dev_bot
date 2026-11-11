/**
 * Optional-env cases for loadConfig.
 * Reuse `baseEnv` (required keys only) when adding new optional fields —
 * keep PUBLIC_BASE_URL off baseEnv so default/warn behavior stays covered here.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  isLocalPublicBaseUrl,
  loadConfig,
  resetConfigCache,
} from "../src/config.js";

/** Required keys only — optional fields omitted on purpose for reuse. */
const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://devbot:devbot@localhost:5432/devbot",
  CURSOR_API_KEY: "cursor-key",
  CURSOR_WEBHOOK_SECRET: "x".repeat(32),
  GITHUB_WEBHOOK_SECRET: "gh-secret",
  GITHUB_TOKEN: "gh-token",
  DEFAULT_REPO: "https://github.com/org/repo",
};

describe("optional chat outbound env", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  it("boots without CHAT_POST_URL / CHAT_BOT_TOKEN / BOT_USER_ID", () => {
    const config = loadConfig({ ...baseEnv });
    assert.equal(config.CHAT_POST_URL, "");
    assert.equal(config.CHAT_BOT_TOKEN, "");
    assert.equal(config.BOT_USER_ID, "");
    assert.equal(config.chatOutboundEnabled, false);
    assert.equal(config.CURSOR_MODEL, "");
  });

  it("enables outbound only when URL and token are both set", () => {
    const config = loadConfig({
      ...baseEnv,
      CHAT_POST_URL: "https://apis.isometrik.io/send",
      CHAT_BOT_TOKEN: "token",
      BOT_USER_ID: "bot",
    });
    assert.equal(config.chatOutboundEnabled, true);
    assert.equal(config.BOT_USER_ID, "bot");
  });
});

describe("optional PUBLIC_BASE_URL", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  it("defaults to http://localhost:3000 when missing or blank", () => {
    const missing = loadConfig({ ...baseEnv });
    assert.equal(missing.PUBLIC_BASE_URL, "http://localhost:3000");
    assert.equal(isLocalPublicBaseUrl(missing.PUBLIC_BASE_URL), true);

    resetConfigCache();
    const blank = loadConfig({ ...baseEnv, PUBLIC_BASE_URL: "" });
    assert.equal(blank.PUBLIC_BASE_URL, "http://localhost:3000");
  });

  it("keeps an explicit public HTTPS URL and does not treat it as local", () => {
    const config = loadConfig({
      ...baseEnv,
      PUBLIC_BASE_URL: "https://example.com",
    });
    assert.equal(config.PUBLIC_BASE_URL, "https://example.com");
    assert.equal(isLocalPublicBaseUrl(config.PUBLIC_BASE_URL), false);
  });

  it("warns once when PUBLIC_BASE_URL is local", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      loadConfig({ ...baseEnv });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /PUBLIC_BASE_URL/);
      assert.match(warnings[0]!, /webhooks need a real public HTTPS URL/i);

      // Memoized — second loadConfig must not warn again.
      loadConfig({ ...baseEnv });
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = original;
    }
  });
});

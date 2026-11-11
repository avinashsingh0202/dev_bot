import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { loadConfig, resetConfigCache } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://devbot:devbot@localhost:5432/devbot",
  CURSOR_API_KEY: "cursor-key",
  CURSOR_WEBHOOK_SECRET: "x".repeat(32),
  GITHUB_WEBHOOK_SECRET: "gh-secret",
  GITHUB_TOKEN: "gh-token",
  DEFAULT_REPO: "https://github.com/org/repo",
  PUBLIC_BASE_URL: "https://example.com",
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMentionOnly,
  startsWithDevbotMention,
  stripDevbotPrefix,
} from "../src/routes/chat.js";

describe("startsWithDevbotMention", () => {
  it("matches the sample `@devbot test` (case-insensitive, trimmed)", () => {
    assert.equal(startsWithDevbotMention("@devbot test"), true);
    assert.equal(startsWithDevbotMention("  @DevBot test"), true);
    assert.equal(startsWithDevbotMention("@DEVBOT"), true);
  });

  it("does not match mid-body mentions or plain chat", () => {
    assert.equal(startsWithDevbotMention("please @devbot fix this"), false);
    assert.equal(startsWithDevbotMention("hello team"), false);
    assert.equal(startsWithDevbotMention(""), false);
  });
});

describe("stripDevbotPrefix", () => {
  it("strips the leading prefix for the agent prompt", () => {
    assert.equal(stripDevbotPrefix("@devbot test"), "test");
    assert.equal(stripDevbotPrefix("@DevBot fix the flaky login"), "fix the flaky login");
    assert.equal(stripDevbotPrefix("@devbot"), "");
  });
});

describe("isMentionOnly", () => {
  it("ignores a bare mention plus whitespace or punctuation", () => {
    assert.equal(isMentionOnly("@devbot"), true);
    assert.equal(isMentionOnly("  @devbot  "), true);
    assert.equal(isMentionOnly("\n@DevBot\t"), true);
    assert.equal(isMentionOnly("@DEVBOT"), true);
    assert.equal(isMentionOnly("@devbot!"), true);
    assert.equal(isMentionOnly("@devbot."), true);
    assert.equal(isMentionOnly("@devbot?"), true);
    assert.equal(isMentionOnly("@devbot,"), true);
    assert.equal(isMentionOnly("@devbot:"), true);
    assert.equal(isMentionOnly("@devbot..."), true);
    assert.equal(isMentionOnly("@devbot!!!"), true);
    assert.equal(isMentionOnly("  @devbot — "), true);
    assert.equal(isMentionOnly("@devbot @devbot"), true);
    assert.equal(isMentionOnly("@devbot, @devbot!"), true);
  });

  it("keeps a substantive task actionable", () => {
    assert.equal(isMentionOnly("@devbot fix the flaky login"), false);
    assert.equal(isMentionOnly("@devbot test"), false);
    assert.equal(isMentionOnly("  @DevBot please look at the timeout  "), false);
    assert.equal(isMentionOnly("@devbot: fix the login"), false);
  });

  it("does not treat unrelated chat as a mention-only request", () => {
    assert.equal(isMentionOnly("please @devbot fix this"), false);
    assert.equal(isMentionOnly("hello team"), false);
    assert.equal(isMentionOnly(""), false);
    assert.equal(isMentionOnly("..."), false);
  });
});

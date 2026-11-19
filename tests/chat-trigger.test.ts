import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NO_TASK_REPLY,
  resolveDevbotRequest,
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

describe("resolveDevbotRequest", () => {
  const mentionOnly = [
    "@devbot",
    "@DEVBOT",
    "@DevBot",
    "  @devbot  ",
    "@devbot\n",
    "@devbot\t",
    "@devbot   ",
    "\u00a0@devbot\u00a0",
    "@devbot\u200b",
    "\u200b@devbot",
    "@devbot.",
    "@devbot!",
    "@devbot?",
    "@devbot @devbot",
    "@devbot new",
    "@devbot new.",
  ];

  it("does not dispatch a mention-only message and does not say On it", () => {
    for (const text of mentionOnly) {
      const decision = resolveDevbotRequest(text);
      assert.equal(decision.action, "no_task", text);
      if (decision.action !== "no_task") continue;
      assert.equal(decision.reply, NO_TASK_REPLY, text);
      assert.notEqual(decision.reply, "On it", text);
    }
  });

  it("dispatches a real engineering request and strips the mention", () => {
    assert.deepEqual(resolveDevbotRequest("@devbot fix the flaky test"), {
      action: "dispatch",
      prompt: "fix the flaky test",
      forceNew: false,
    });
    assert.deepEqual(resolveDevbotRequest("  @DevBot fix the flaky login"), {
      action: "dispatch",
      prompt: "fix the flaky login",
      forceNew: false,
    });
    assert.deepEqual(resolveDevbotRequest("@devbot test"), {
      action: "dispatch",
      prompt: "test",
      forceNew: false,
    });
  });

  it("still starts a fresh agent when a task follows new", () => {
    assert.deepEqual(resolveDevbotRequest("@devbot new fix the flaky test"), {
      action: "dispatch",
      prompt: "fix the flaky test",
      forceNew: true,
    });
  });

  it("keeps related-bug notes on the normal dispatch path", () => {
    assert.deepEqual(resolveDevbotRequest("@devbot same bug"), {
      action: "dispatch",
      prompt: "same bug",
      forceNew: false,
    });
  });

  it("ignores mid-message mentions with no reply", () => {
    assert.deepEqual(resolveDevbotRequest("please @devbot fix this"), {
      action: "ignore",
    });
    assert.deepEqual(resolveDevbotRequest("hello team"), { action: "ignore" });
    assert.deepEqual(resolveDevbotRequest(""), { action: "ignore" });
  });
});

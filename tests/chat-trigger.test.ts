import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { greetingReply } from "../src/greeting.js";
import {
  planUnthreadedChat,
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

describe("planUnthreadedChat", () => {
  it("answers a greeting with the welcome menu and does not dispatch", () => {
    const reply = greetingReply();
    for (const text of ["hi", "Hello!", "@devbot hi", "  @DevBot hello there"]) {
      assert.deepEqual(planUnthreadedChat(text), {
        action: "greet",
        reply,
      });
    }
    assert.notEqual(reply, "On it");
  });

  it("still dispatches a real request and strips the mention", () => {
    assert.deepEqual(planUnthreadedChat("@devbot fix the flaky test"), {
      action: "dispatch",
      prompt: "fix the flaky test",
      forceNew: false,
    });
    assert.deepEqual(planUnthreadedChat("@devbot test"), {
      action: "dispatch",
      prompt: "test",
      forceNew: false,
    });
  });

  it("still starts a fresh agent when a task follows new", () => {
    assert.deepEqual(planUnthreadedChat("@devbot new fix the flaky test"), {
      action: "dispatch",
      prompt: "fix the flaky test",
      forceNew: true,
    });
  });

  it("ignores plain chat that is not a greeting", () => {
    assert.deepEqual(planUnthreadedChat("hello team"), { action: "ignore" });
    assert.deepEqual(planUnthreadedChat("please @devbot fix this"), {
      action: "ignore",
    });
    assert.deepEqual(planUnthreadedChat(""), { action: "ignore" });
  });
});

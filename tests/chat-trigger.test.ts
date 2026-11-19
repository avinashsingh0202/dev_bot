import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDevbotRequest,
  DEVBOT_NEEDS_TASK_REPLY,
  isBareDevbotMention,
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

describe("isBareDevbotMention", () => {
  it("matches a mention with only whitespace or punctuation", () => {
    for (const text of [
      "@devbot",
      "  @devbot  ",
      "@DEVBOT",
      "@devbot!",
      "@devbot?",
      "@devbot.",
      "@devbot...",
      "@devbot,",
      "@devbot: ",
    ]) {
      assert.equal(isBareDevbotMention(text), true, text);
    }
  });

  it("does not match a mention that includes a task", () => {
    assert.equal(isBareDevbotMention("@devbot test"), false);
    assert.equal(isBareDevbotMention("@devbot fix the flaky login"), false);
    assert.equal(isBareDevbotMention("please @devbot"), false);
  });
});

describe("classifyDevbotRequest", () => {
  it("asks for a task on a bare mention and does not dispatch", () => {
    for (const text of ["@devbot", "  @DevBot  ", "@devbot!", "@devbot???"]) {
      const decision = classifyDevbotRequest(text);
      assert.equal(decision.kind, "clarify", text);
      if (decision.kind !== "clarify") continue;
      assert.equal(decision.reply, DEVBOT_NEEDS_TASK_REPLY);
      assert.notEqual(decision.reply, "On it");
      assert.match(decision.reply, /task/i);
    }
  });

  it("does not dispatch greetings or other empty chatter", () => {
    for (const text of [
      "@devbot hi",
      "@devbot hello!",
      "@devbot hey there",
      "@devbot thanks",
      "@devbot thank you",
      "@devbot good morning",
      "@devbot what's up?",
      "@devbot how are you",
      "@devbot help",
      "@devbot please",
      "@devbot new",
      "@devbot new!",
    ]) {
      const decision = classifyDevbotRequest(text);
      assert.equal(decision.kind, "clarify", text);
      if (decision.kind !== "clarify") continue;
      assert.notEqual(decision.reply, "On it");
    }
  });

  it("dispatches a representative engineering request", () => {
    assert.deepEqual(classifyDevbotRequest("@devbot fix the flaky login test"), {
      kind: "dispatch",
      prompt: "fix the flaky login test",
      forceNew: false,
    });
  });

  it("keeps short real requests and fresh-agent tasks on the dispatch path", () => {
    assert.deepEqual(classifyDevbotRequest("@devbot test"), {
      kind: "dispatch",
      prompt: "test",
      forceNew: false,
    });
    assert.deepEqual(classifyDevbotRequest("@devbot new fix the parser"), {
      kind: "dispatch",
      prompt: "fix the parser",
      forceNew: true,
    });
  });

  it("still dispatches when a greeting is followed by a task", () => {
    const decision = classifyDevbotRequest(
      "@devbot hey can you fix the login timeout",
    );
    assert.equal(decision.kind, "dispatch");
    if (decision.kind !== "dispatch") return;
    assert.equal(decision.prompt, "hey can you fix the login timeout");
    assert.equal(decision.forceNew, false);
  });

  it("still dispatches vague related-bug reports", () => {
    assert.equal(classifyDevbotRequest("@devbot same bug").kind, "dispatch");
    assert.equal(classifyDevbotRequest("@devbot still broken").kind, "dispatch");
  });
});

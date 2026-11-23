import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GREETING_OPTIONS,
  greetingReply,
  isInitialGreeting,
} from "../src/greeting.js";

describe("isInitialGreeting", () => {
  const greetings = [
    "hi",
    "Hi",
    "HI",
    "  hi  ",
    "hi!",
    "hi.",
    "hi?",
    "hii",
    "hiii",
    "hey",
    "heyy",
    "hello",
    "hello!",
    "hey there",
    "hi there",
    "good morning",
    "good afternoon",
    "what's up",
    "whats up",
    "@devbot hi",
    "@DevBot hello",
    "  @DEVBOT hi!  ",
    "@devbot, hi",
    "@devbot @devbot hello",
    "@devbot\u200b hi",
    "\u00a0hi\u00a0",
    "hi 👋",
    "hello devbot",
  ];

  it("recognizes a standalone greeting, including a leading mention", () => {
    for (const text of greetings) {
      assert.equal(isInitialGreeting(text), true, text);
    }
  });

  it("does not treat a real request or plain team chat as a greeting", () => {
    const notGreetings = [
      "",
      "   ",
      "@devbot",
      "hello team",
      "high priority bug in checkout",
      "hit the login button",
      "hi, fix the flaky login",
      "@devbot fix the flaky test",
      "@devbot new fix the flaky test",
      "please @devbot fix this",
      "@devbot same bug",
      "status",
    ];
    for (const text of notGreetings) {
      assert.equal(isInitialGreeting(text), false, text);
    }
  });
});

describe("greetingReply", () => {
  const reply = greetingReply();

  it("opens with a warm welcome and lists at least four actions", () => {
    assert.match(reply, /^Hi, welcome\./);
    assert.match(reply, /Happy to help/);
    assert.ok(GREETING_OPTIONS.length >= 4);
    GREETING_OPTIONS.forEach((option, index) => {
      assert.ok(reply.includes(`${index + 1}. ${option}`), option);
    });
    assert.match(reply, /task card/i);
    assert.match(reply, /pull request/i);
    assert.match(reply, /status/i);
    assert.match(reply, /help/i);
  });

  it("does not ask a question or request more detail", () => {
    assert.equal(reply.includes("?"), false);
    assert.doesNotMatch(
      reply,
      /which |what |could you|can you|let me know|tell me|more detail|clarify|please provide|want me to/i,
    );
  });

  it("stays generic and does not name internal systems", () => {
    assert.doesNotMatch(
      reply,
      /cursor|github|isometrik|webhook|postgres|database|api key|secret|token|cloud agent|agent id|follow-?up/i,
    );
    assert.notEqual(reply, "On it");
  });
});

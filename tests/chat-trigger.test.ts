import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMentionOnly,
  normalizeRequestContent,
  prepareNewRequest,
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

  it("keeps task text that follows whitespace or a later mention", () => {
    assert.equal(stripDevbotPrefix("@devbot\nfix the login"), "fix the login");
    assert.equal(
      stripDevbotPrefix("@devbot fix the @devbot parser"),
      "fix the @devbot parser",
    );
  });
});

describe("normalizeRequestContent", () => {
  it("is empty for mention-only and whitespace-only residue", () => {
    assert.equal(normalizeRequestContent("@devbot"), "");
    assert.equal(normalizeRequestContent("@DevBot"), "");
    assert.equal(normalizeRequestContent("@DEVBOT"), "");
    assert.equal(normalizeRequestContent("  @devbot  "), "");
    assert.equal(normalizeRequestContent("@devbot   "), "");
    assert.equal(normalizeRequestContent("@devbot\n\t "), "");
    assert.equal(normalizeRequestContent("@devbot\u00a0"), "");
  });

  it("is empty for stacked mentions and mention-only punctuation", () => {
    assert.equal(normalizeRequestContent("@devbot @devbot"), "");
    assert.equal(normalizeRequestContent("@devbot, @DevBot!"), "");
    assert.equal(normalizeRequestContent("@devbot."), "");
    assert.equal(normalizeRequestContent("@devbot!"), "");
    assert.equal(normalizeRequestContent("@devbot:"), "");
  });

  it("keeps task words and does not treat them as mention syntax", () => {
    assert.equal(normalizeRequestContent("@devbot test"), "test");
    assert.equal(
      normalizeRequestContent("@devbot fix the flaky login"),
      "fix the flaky login",
    );
    assert.equal(
      normalizeRequestContent("@devbot fix the @devbot parser"),
      "fix the parser",
    );
  });
});

describe("prepareNewRequest", () => {
  it("does not dispatch a mention-only message", () => {
    assert.equal(prepareNewRequest("@devbot"), null);
    assert.equal(prepareNewRequest("@DevBot"), null);
    assert.equal(prepareNewRequest("  @DEVBOT  "), null);
    assert.equal(prepareNewRequest("@devbot @devbot"), null);
    assert.equal(prepareNewRequest("@devbot."), null);
  });

  it("does not dispatch when only whitespace remains after the mention", () => {
    assert.equal(prepareNewRequest("@devbot   "), null);
    assert.equal(prepareNewRequest("@devbot\n"), null);
    assert.equal(prepareNewRequest("@devbot\t\t"), null);
    assert.equal(prepareNewRequest("@devbot \n\t "), null);
    assert.equal(prepareNewRequest("@devbot\u00a0\u00a0"), null);
  });

  it("dispatches a real task after the mention on the existing prompt path", () => {
    assert.deepEqual(prepareNewRequest("@devbot test"), {
      rawPrompt: "test",
      prompt: "test",
      forceNew: false,
    });
    assert.deepEqual(prepareNewRequest("@DevBot fix the flaky login"), {
      rawPrompt: "fix the flaky login",
      prompt: "fix the flaky login",
      forceNew: false,
    });
    assert.deepEqual(prepareNewRequest("@devbot\nfix the login"), {
      rawPrompt: "fix the login",
      prompt: "fix the login",
      forceNew: false,
    });
    // A later mention is part of the task, not dropped from the prompt.
    assert.deepEqual(prepareNewRequest("@devbot fix the @devbot parser"), {
      rawPrompt: "fix the @devbot parser",
      prompt: "fix the @devbot parser",
      forceNew: false,
    });
  });

  it("keeps the fresh-agent prefix path for a task after new", () => {
    assert.deepEqual(prepareNewRequest("@devbot new fix login"), {
      rawPrompt: "new fix login",
      prompt: "fix login",
      forceNew: true,
    });
  });

  it("does not dispatch a fresh-agent prefix that leaves only a mention", () => {
    assert.equal(prepareNewRequest("@devbot new @devbot"), null);
  });

  it("does not treat a mid-message mention as a new request", () => {
    assert.equal(prepareNewRequest("please @devbot fix this"), null);
    assert.equal(prepareNewRequest("hello team"), null);
  });
});

describe("isMentionOnly", () => {
  it("is true for a bare mention, including whitespace and stacked mentions", () => {
    assert.equal(isMentionOnly("@devbot"), true);
    assert.equal(isMentionOnly("@DevBot"), true);
    assert.equal(isMentionOnly("@devbot   "), true);
    assert.equal(isMentionOnly("@devbot\n\t"), true);
    assert.equal(isMentionOnly("@devbot @devbot"), true);
    assert.equal(isMentionOnly("@devbot!"), true);
  });

  it("is false when the mention is followed by a task or there is no mention", () => {
    assert.equal(isMentionOnly("@devbot fix the flaky login"), false);
    assert.equal(isMentionOnly("@devbot new fix login"), false);
    assert.equal(isMentionOnly("please look at the login"), false);
    assert.equal(isMentionOnly("status"), false);
  });
});

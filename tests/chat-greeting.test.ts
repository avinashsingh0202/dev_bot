import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGreetingReply,
  isGreeting,
  startsWithDevbotMention,
  stripDevbotPrefix,
} from "../src/routes/chat.js";

describe("isGreeting", () => {
  it("matches a bare greeting, including the sample 'hi'", () => {
    for (const text of [
      "hi",
      "Hi",
      "Hi!",
      "  hello  ",
      "hello there",
      "hey",
      "hey there",
      "heya",
      "hiya",
      "howdy",
      "yo",
      "sup",
      "greetings",
      "what's up",
      "whats up",
      "good morning",
      "good afternoon!",
      "good evening",
      "hiii",
    ]) {
      assert.equal(isGreeting(text), true, text);
    }
  });

  it("does not treat a real request as a greeting", () => {
    for (const text of [
      "",
      "status",
      "help",
      "hi, fix the login bug",
      "hello, the export button is broken",
      "hey can you open a pull request",
      "good morning, please check the failing build",
      "create a card for the export bug",
      "high priority login fix",
      "history of this bug",
    ]) {
      assert.equal(isGreeting(text), false, text);
    }
  });

  it("treats @devbot hi as a greeting and keeps real prompts as work", () => {
    const hi = "@devbot hi";
    assert.equal(startsWithDevbotMention(hi), true);
    assert.equal(isGreeting(stripDevbotPrefix(hi)), true);

    const work = "@devbot hi, fix the flaky login";
    assert.equal(startsWithDevbotMention(work), true);
    assert.equal(isGreeting(stripDevbotPrefix(work)), false);

    assert.equal(isGreeting(stripDevbotPrefix("@DevBot hello there!")), true);
    assert.equal(isGreeting(stripDevbotPrefix("@devbot")), false);
  });
});

describe("buildGreetingReply", () => {
  it("welcomes and lists four actions without questions or internal tools", () => {
    const reply = buildGreetingReply();

    assert.match(reply, /hi!/i);
    assert.match(reply, /glad you are here/i);
    assert.match(reply, /create a new task or card for a feature or a bug/i);
    assert.match(reply, /start a code change and open a pull request/i);
    assert.match(reply, /check the status of ongoing work/i);
    assert.match(reply, /get help on a topic/i);

    const options = reply.match(/^\d+\. /gm) ?? [];
    assert.equal(options.length, 4);

    assert.equal(reply.includes("?"), false);
    assert.doesNotMatch(
      reply,
      /\b(cursor|github|isometrik|webhook|agent|slack|token|secret)\b/i,
    );
  });
});

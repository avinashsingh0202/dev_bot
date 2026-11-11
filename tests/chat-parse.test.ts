import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChatMessage } from "../src/routes/chat.js";

describe("parseChatMessage", () => {
  it("maps the spec snake_case shape", () => {
    const msg = parseChatMessage({
      message_id: "m1",
      thread_id: "t1",
      channel_id: "c1",
      sender_id: "u1",
      sender_name: "Ada",
      text: "@devbot fix the flaky test",
    });
    assert.deepEqual(msg, {
      messageId: "m1",
      threadId: "t1",
      channelId: "c1",
      senderId: "u1",
      senderName: "Ada",
      text: "@devbot fix the flaky test",
    });
  });

  it("accepts camelCase aliases for reuse with alternate vendors", () => {
    const msg = parseChatMessage({
      messageId: 42,
      channelId: "general",
      senderId: "bob",
      senderName: "Bob",
      text: "hello",
    });
    assert.equal(msg.messageId, "42");
    assert.equal(msg.threadId, null);
    assert.equal(msg.channelId, "general");
    assert.equal(msg.senderId, "bob");
  });

  it("trims text and falls back to message/body fields", () => {
    const msg = parseChatMessage({
      message_id: "m2",
      channel_id: "c",
      sender_id: "s",
      message: "  padded  ",
    });
    assert.equal(msg.text, "padded");
  });

  it("throws when required ids are missing", () => {
    assert.throws(() => parseChatMessage({ text: "no ids" }), /missing/);
  });
});

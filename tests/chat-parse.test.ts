import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChatMessage } from "../src/routes/chat.js";

describe("parseChatMessage (Isometrik)", () => {
  it("maps Isometrik chatMessageSent fields", () => {
    const msg = parseChatMessage({
      action: "chatMessageSent",
      messageId: "msg_root",
      conversationId: "conv_1",
      senderId: "user_ada",
      senderName: "Ada",
      body: "@devbot fix the flaky test",
    });
    assert.deepEqual(msg, {
      messageId: "msg_root",
      threadId: "msg_root", // no parent → thread root is this message
      channelId: "conv_1",
      senderId: "user_ada",
      senderName: "Ada",
      text: "@devbot fix the flaky test",
      action: "chatMessageSent",
    });
  });

  it("uses parentMessageId as thread when present", () => {
    const msg = parseChatMessage({
      action: "chatMessageSent",
      messageId: "msg_reply",
      parentMessageId: "msg_root",
      conversationId: "conv_1",
      senderId: "user_bob",
      senderName: "Bob",
      body: "status",
    });
    assert.equal(msg.threadId, "msg_root");
    assert.equal(msg.messageId, "msg_reply");
  });

  it("falls back to notificationBody when body is absent", () => {
    const msg = parseChatMessage({
      messageId: "m2",
      conversationId: "c",
      senderId: "s",
      notificationBody: "  @DevBot please look  ",
    });
    assert.equal(msg.text, "@DevBot please look");
  });

  it("still accepts Phase 1 snake_case curl fixtures", () => {
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
      action: null,
    });
  });

  it("throws when required ids are missing", () => {
    assert.throws(() => parseChatMessage({ body: "no ids" }), /missing/);
  });
});

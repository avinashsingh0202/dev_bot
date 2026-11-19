import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isChatAllowed } from "../src/routes/chat.js";

const POC_USER = "661e62abed6eab0034a910ef";
const POC_CONV = "6af4f6f3e94e470001d1326e";

const pocConfig = {
  BOT_USER_ID: "devbot",
  allowedUserIds: new Set([POC_USER]),
  allowedConversationIds: new Set([POC_CONV]),
};

describe("isChatAllowed (POC allowlists)", () => {
  it("allows the documented POC sender + conversation", () => {
    assert.equal(
      isChatAllowed({ senderId: POC_USER, channelId: POC_CONV }, pocConfig),
      true,
    );
  });

  it("rejects other senders with no reply path", () => {
    assert.equal(
      isChatAllowed(
        { senderId: "someone-else", channelId: POC_CONV },
        pocConfig,
      ),
      false,
    );
  });

  it("rejects other conversations with no reply path", () => {
    assert.equal(
      isChatAllowed(
        { senderId: POC_USER, channelId: "other-conversation" },
        pocConfig,
      ),
      false,
    );
  });

  it("rejects the bot user id", () => {
    assert.equal(
      isChatAllowed(
        { senderId: "devbot", channelId: POC_CONV },
        pocConfig,
      ),
      false,
    );
  });

  it("allows all when both allowlists are empty", () => {
    const open = {
      BOT_USER_ID: "devbot",
      allowedUserIds: new Set<string>(),
      allowedConversationIds: new Set<string>(),
    };
    assert.equal(
      isChatAllowed({ senderId: "anyone", channelId: "any-conv" }, open),
      true,
    );
  });

  it("does not filter self-messages when BOT_USER_ID is empty", () => {
    const open = {
      BOT_USER_ID: "",
      allowedUserIds: new Set<string>(),
      allowedConversationIds: new Set<string>(),
    };
    assert.equal(
      isChatAllowed({ senderId: "devbot", channelId: POC_CONV }, open),
      true,
    );
  });

  it("checks only the dimensions that are configured", () => {
    const usersOnly = {
      BOT_USER_ID: "",
      allowedUserIds: new Set([POC_USER]),
      allowedConversationIds: new Set<string>(),
    };
    assert.equal(
      isChatAllowed({ senderId: POC_USER, channelId: "anywhere" }, usersOnly),
      true,
    );
    assert.equal(
      isChatAllowed({ senderId: "nope", channelId: "anywhere" }, usersOnly),
      false,
    );

    const convOnly = {
      BOT_USER_ID: "",
      allowedUserIds: new Set<string>(),
      allowedConversationIds: new Set([POC_CONV]),
    };
    assert.equal(
      isChatAllowed({ senderId: "anyone", channelId: POC_CONV }, convOnly),
      true,
    );
    assert.equal(
      isChatAllowed({ senderId: "anyone", channelId: "nope" }, convOnly),
      false,
    );
  });
});

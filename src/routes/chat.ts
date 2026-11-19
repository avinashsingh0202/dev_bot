/**
 * Inbound chat webhook (Isometrik-style payloads).
 * parseChatMessage() is the single adapter point for vendor field mapping —
 * see /cursor/stores/self/internal/isometrik-chat-mapping.md for the table.
 * Keep snake_case aliases so curl/examples and Phase 1 tests still work.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  createRequest,
  findRequestByThread,
  listReusableRequests,
  logEvent,
  updateRequest,
} from "../db.js";
import { postMessage } from "../clients/chat.js";
import { sendFollowup } from "../clients/cursor.js";
import { routeRelatedReport } from "../followup.js";
import { enqueueOrLaunch } from "../queue.js";
import {
  pickRelatedRequest,
  RELATED_LOOKBACK_MS,
  REUSABLE_AGENT_STATUSES,
  stripFreshAgentPrefix,
  wantsFreshAgent,
} from "../related.js";

export interface ParsedChatMessage {
  messageId: string;
  /** parentMessageId when present; otherwise messageId (thread root). */
  threadId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** e.g. chatMessageSent — informational; not required to process. */
  action: string | null;
}

const rawChatSchema = z
  .object({
    // Isometrik (primary)
    action: z.string().optional(),
    messageId: z.union([z.string(), z.number()]).optional(),
    conversationId: z.union([z.string(), z.number()]).optional(),
    parentMessageId: z.union([z.string(), z.number()]).nullable().optional(),
    senderId: z.union([z.string(), z.number()]).optional(),
    senderName: z.string().optional(),
    body: z.string().optional(),
    notificationBody: z.string().optional(),
    // Phase 1 / curl aliases (reuse)
    message_id: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    thread_id: z.union([z.string(), z.number()]).nullable().optional(),
    threadId: z.union([z.string(), z.number()]).nullable().optional(),
    channel_id: z.union([z.string(), z.number()]).optional(),
    channelId: z.union([z.string(), z.number()]).optional(),
    sender_id: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    sender_name: z.string().optional(),
    user_name: z.string().optional(),
    text: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

function asString(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

/**
 * Normalize inbound chat JSON into a stable shape.
 * Isometrik first (body, conversationId, …); snake_case kept for curl reuse.
 */
export function parseChatMessage(body: unknown): ParsedChatMessage {
  const parsed = rawChatSchema.parse(body ?? {});

  const messageId =
    asString(parsed.messageId) ??
    asString(parsed.message_id) ??
    asString(parsed.id);

  const channelId =
    asString(parsed.conversationId) ??
    asString(parsed.channel_id) ??
    asString(parsed.channelId);

  const senderId =
    asString(parsed.senderId) ??
    asString(parsed.sender_id) ??
    asString(parsed.user_id);

  const senderName =
    parsed.senderName ??
    parsed.sender_name ??
    parsed.user_name ??
    "unknown";

  // Isometrik: body, then notificationBody; aliases for local curl fixtures
  const text =
    parsed.body ??
    parsed.notificationBody ??
    parsed.text ??
    parsed.message ??
    "";

  if (!messageId || !channelId || !senderId) {
    throw new Error(
      "chat message missing required fields (messageId/conversationId/senderId)",
    );
  }

  // Thread root = this message when parentMessageId is absent
  const threadId =
    asString(parsed.parentMessageId) ??
    asString(parsed.thread_id) ??
    asString(parsed.threadId) ??
    messageId;

  return {
    messageId,
    threadId,
    channelId,
    senderId,
    senderName,
    text: text.trim(),
    action: parsed.action ?? null,
  };
}

/**
 * New requests only: trimmed body must *start with* `@devbot` (case-insensitive).
 * Mid-message mentions do not trigger. Thread replies skip this check.
 */
export function startsWithDevbotMention(text: string): boolean {
  return /^@devbot\b/i.test(text.trim());
}

/** Strip leading `@devbot` (+ following space) for the agent prompt. */
export function stripDevbotPrefix(text: string): string {
  return text.trim().replace(/^@devbot\b\s*/i, "").trim();
}

/**
 * Reply for a mention that has no engineering task.
 * Must not be "On it" — that ack is only for a real dispatch.
 */
export const DEVBOT_NEEDS_TASK_REPLY =
  "Send a task after @devbot. Example: @devbot fix the flaky login test";

export type DevbotDispatch =
  | { kind: "clarify"; reply: string }
  | { kind: "dispatch"; prompt: string; forceNew: boolean };

/**
 * Words that never make a message an engineering task by themselves.
 * "test" is absent on purpose: `@devbot test` is a real request.
 * Imperatives (fix, add, check, look) are absent so a short task still dispatches.
 */
const CONVERSATIONAL_FILLER = new Set([
  "hi",
  "hii",
  "hello",
  "hey",
  "heya",
  "hiya",
  "yo",
  "sup",
  "howdy",
  "hola",
  "hai",
  "good",
  "morning",
  "afternoon",
  "evening",
  "night",
  "gm",
  "gn",
  "thanks",
  "thank",
  "thx",
  "ty",
  "tysm",
  "yw",
  "np",
  "welcome",
  "cheers",
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "nice",
  "great",
  "awesome",
  "perfect",
  "sure",
  "yes",
  "no",
  "yep",
  "nope",
  "yeah",
  "nah",
  "yea",
  "y",
  "bye",
  "goodbye",
  "cya",
  "later",
  "sorry",
  "ping",
  "lol",
  "lmao",
  "haha",
  "hehe",
  "wow",
  "omg",
  "hmm",
  "hm",
  "uh",
  "um",
  "help",
  "please",
  "pls",
  "plz",
  "what",
  "whats",
  "how",
  "who",
  "are",
  "you",
  "u",
  "ya",
  "up",
  "doing",
  "there",
  "can",
  "could",
  "would",
  "will",
  "i",
  "im",
  "me",
  "my",
  "we",
  "our",
  "a",
  "an",
  "the",
  "to",
  "for",
  "and",
  "or",
  "of",
  "just",
  "so",
  "it",
  "its",
  "this",
  "that",
  "do",
  "does",
  "did",
  "bot",
  "devbot",
  "team",
  "everyone",
  "folks",
  "guys",
  "all",
]);

/**
 * `@devbot` plus surrounding whitespace or punctuation, and no task text.
 * `@devbot!`, `@devbot?`, and `@devbot...` count. `@devbot fix login` does not.
 */
export function isBareDevbotMention(text: string): boolean {
  if (!startsWithDevbotMention(text)) return false;
  return !/[a-z0-9]/i.test(stripDevbotPrefix(text));
}

/** Task words left after dropping greetings, thanks, and other chatter. */
function hasActionableTask(prompt: string): boolean {
  const tokens = prompt
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !CONVERSATIONAL_FILLER.has(token));
  return tokens.length > 0;
}

/**
 * Bare mentions and conversational filler do not start work.
 * Anything with a task word still dispatches, including `@devbot test`
 * and `@devbot new <task>`. Callers must not create a request or launch
 * when the result is `clarify`.
 */
export function classifyDevbotRequest(text: string): DevbotDispatch {
  const rawPrompt = stripDevbotPrefix(text);
  const forceNew = wantsFreshAgent(rawPrompt);
  const prompt = forceNew ? stripFreshAgentPrefix(rawPrompt) : rawPrompt;
  if (!hasActionableTask(prompt)) {
    return { kind: "clarify", reply: DEVBOT_NEEDS_TASK_REPLY };
  }
  return { kind: "dispatch", prompt, forceNew };
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * POC allowlists from env (ALLOWED_USER_IDS / ALLOWED_CONVERSATION_IDS).
 * Empty set = unrestricted for that dimension. Bot self-messages always drop.
 * Pure helper — unit-tested; processChatMessage calls this before any reply.
 */
export function isChatAllowed(
  msg: Pick<ParsedChatMessage, "senderId" | "channelId">,
  config: {
    BOT_USER_ID: string;
    allowedUserIds: Set<string>;
    allowedConversationIds: Set<string>;
  },
): boolean {
  // BOT_USER_ID optional for POC — only filter self when set
  if (config.BOT_USER_ID && msg.senderId === config.BOT_USER_ID) return false;
  if (
    config.allowedUserIds.size > 0 &&
    !config.allowedUserIds.has(msg.senderId)
  ) {
    return false;
  }
  if (
    config.allowedConversationIds.size > 0 &&
    !config.allowedConversationIds.has(msg.channelId)
  ) {
    return false;
  }
  return true;
}

async function processChatMessage(msg: ParsedChatMessage): Promise<void> {
  const config = loadConfig();

  // Wrong sender / conversation → silent ignore (no chat reply)
  if (!isChatAllowed(msg, config)) return;

  // Reply in an existing request thread
  if (msg.threadId) {
    const existing = await findRequestByThread(msg.channelId, msg.threadId);
    if (existing) {
      const cmd = normalizeCommand(msg.text);
      if (cmd === "retry") {
        if (!existing.agent_id) {
          await postMessage(
            msg.channelId,
            msg.threadId,
            "No agent to retry yet",
          );
          return;
        }
        await sendFollowup(
          existing.agent_id,
          `${msg.senderName} says: please retry the previous fix on the same branch`,
        );
        await updateRequest(existing.id, { status: "agent_running" });
        const summary = "Retry requested — agent follow-up sent";
        await postMessage(msg.channelId, msg.threadId, summary);
        await logEvent({
          requestId: existing.id,
          type: "retry",
          source: "chat",
          summary,
        });
        return;
      }
      if (cmd === "stop") {
        await updateRequest(existing.id, { status: "stopped" });
        const summary = "Stopped";
        await postMessage(msg.channelId, msg.threadId, summary);
        await logEvent({
          requestId: existing.id,
          type: "stopped",
          source: "chat",
          summary,
        });
        return;
      }
      if (cmd === "status") {
        const summary = [
          `Status: ${existing.status}`,
          existing.branch ? `Branch: ${existing.branch}` : null,
          existing.pr_url ? `PR: ${existing.pr_url}` : null,
          `CI attempts: ${existing.ci_attempts}`,
        ]
          .filter(Boolean)
          .join("\n");
        await postMessage(msg.channelId, msg.threadId, summary);
        await logEvent({
          requestId: existing.id,
          type: "status",
          source: "chat",
          summary,
        });
        return;
      }

      if (existing.agent_id) {
        await sendFollowup(
          existing.agent_id,
          `${msg.senderName} says: ${msg.text}`,
        );
        await logEvent({
          requestId: existing.id,
          type: "followup",
          source: "chat",
          summary: `Forwarded thread reply from ${msg.senderName}`,
          payload: { text: msg.text },
        });
      }
      return;
    }
  }

  // New request only when trimmed body starts with @devbot (not every allowlisted msg)
  if (!startsWithDevbotMention(msg.text)) return;

  // Bare @devbot and greetings ask for a task. No request row, no "On it", no launch.
  const decision = classifyDevbotRequest(msg.text);
  if (decision.kind === "clarify") {
    await postMessage(msg.channelId, msg.threadId, decision.reply);
    return;
  }

  // `@devbot new …` always starts a fresh agent. Anything else that matches
  // an open bug is a follow-up on that agent (see src/related.ts).
  const { prompt, forceNew } = decision;
  const threadId = msg.threadId;

  if (!forceNew) {
    const open = await listReusableRequests({
      chatChannel: msg.channelId,
      repo: config.DEFAULT_REPO,
      since: new Date(Date.now() - RELATED_LOOKBACK_MS),
      statuses: REUSABLE_AGENT_STATUSES,
    });
    const match = pickRelatedRequest(prompt, open);
    const existing = match ? open.find((row) => row.id === match.id) : undefined;
    if (match && existing) {
      try {
        const outcome = await routeRelatedReport({
          request: existing,
          senderName: msg.senderName,
          text: prompt,
          replyChannel: msg.channelId,
          replyThread: threadId,
          reason: match.reason,
        });
        // A retired agent cannot take the follow-up; fall through and launch.
        if (outcome !== "agent_gone") return;
      } catch (err) {
        console.error(
          "[chat] related follow-up failed, starting a new agent",
          err,
        );
      }
    }
  }

  const request = await createRequest({
    chatChannel: msg.channelId,
    chatThread: threadId,
    requestedBy: msg.senderId,
    requestedByName: msg.senderName,
    prompt,
    repo: config.DEFAULT_REPO,
  });

  await postMessage(msg.channelId, threadId, "On it");
  await logEvent({
    requestId: request.id,
    type: "received",
    source: "chat",
    summary: "On it",
    payload: { prompt, sender: msg.senderName, action: msg.action },
  });

  await enqueueOrLaunch({
    request,
    senderName: msg.senderName,
    text: prompt,
  });
}

export function createChatRouter(): Router {
  const router = Router();

  router.post("/webhooks/chat", (req: Request, res: Response) => {
    // Always acknowledge quickly; process async. Bad payloads → 200 after log.
    let msg: ParsedChatMessage;
    try {
      msg = parseChatMessage(req.body);
    } catch (err) {
      console.error("[chat] bad payload", err);
      res.status(200).json({ ok: false, error: "bad_payload" });
      return;
    }

    res.status(200).json({ ok: true });

    void processChatMessage(msg).catch((err) => {
      console.error("[chat] async processing failed", err);
    });
  });

  return router;
}

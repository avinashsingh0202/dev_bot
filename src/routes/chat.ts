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
 * Task words left after removing supported `@devbot` mentions, whitespace,
 * and mention-only syntax (punctuation or other non-word residue such as
 * `@devbot.`, `@devbot!`, or a stack of mentions). Empty means there is no
 * engineering request. Classification only — `prepareNewRequest` still stores
 * the leading-prefix strip, so a later `@devbot` stays in the task text.
 */
export function normalizeRequestContent(text: string): string {
  return text
    .replace(/@devbot\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface PreparedRequest {
  /** Text after the leading mention, before the fresh-agent prefix. */
  rawPrompt: string;
  /** Prompt stored on the request and sent to the agent. */
  prompt: string;
  forceNew: boolean;
}

/**
 * New-request dispatch plan. Null is the existing silent no-op: the message
 * does not start with `@devbot`, or nothing actionable remains after mentions,
 * whitespace, and mention-only syntax are removed. A real task keeps the
 * leading-prefix strip, including a later `@devbot` inside the task text.
 */
export function prepareNewRequest(text: string): PreparedRequest | null {
  if (!startsWithDevbotMention(text)) return null;
  const rawPrompt = stripDevbotPrefix(text);
  if (!normalizeRequestContent(rawPrompt)) return null;

  const forceNew = wantsFreshAgent(rawPrompt);
  const stripped = forceNew ? stripFreshAgentPrefix(rawPrompt) : rawPrompt;
  // `@devbot new` with no further task falls back to the raw prompt, matching
  // the previous fresh-agent path. A result that is only another mention
  // (for example `@devbot new @devbot`) is not a request.
  const prompt = stripped || rawPrompt;
  if (!normalizeRequestContent(prompt)) return null;

  return { rawPrompt, prompt, forceNew };
}

/**
 * Bare `@devbot` (any case, stacked mentions, whitespace, or leftover
 * mention punctuation). Thread replies use this so a ping is not forwarded
 * to Cursor; a reply that never mentioned the bot is unchanged.
 */
export function isMentionOnly(text: string): boolean {
  return startsWithDevbotMention(text) && prepareNewRequest(text) == null;
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
        // `@devbot` alone is not a follow-up. Same silent no-op as a new
        // mention-only message: no Cursor call and no acknowledgement.
        if (isMentionOnly(msg.text)) return;
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

  // Mention-only (@devbot, whitespace, stacked mentions, leftover punctuation)
  // is the same silent no-op as a message that never mentioned the bot:
  // no "On it", no request row, no agent launch.
  const prepared = prepareNewRequest(msg.text);
  if (!prepared) return;

  // `@devbot new …` always starts a fresh agent. Anything else that matches
  // an open bug is a follow-up on that agent (see src/related.ts).
  const { prompt, forceNew } = prepared;
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

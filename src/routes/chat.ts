/**
 * Inbound chat webhook.
 * parseChatMessage() is the single adapter point for vendor field mapping —
 * update that function when sample JSON from the real chat vendor arrives.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  createRequest,
  findRequestByThread,
  logEvent,
  updateRequest,
} from "../db.js";
import { postMessage } from "../clients/chat.js";
import { sendFollowup } from "../clients/cursor.js";
import { enqueueOrLaunch } from "../queue.js";

export interface ParsedChatMessage {
  messageId: string;
  threadId: string | null;
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
}

const rawChatSchema = z
  .object({
    message_id: z.union([z.string(), z.number()]).optional(),
    messageId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    thread_id: z.union([z.string(), z.number()]).nullable().optional(),
    threadId: z.union([z.string(), z.number()]).nullable().optional(),
    channel_id: z.union([z.string(), z.number()]).optional(),
    channelId: z.union([z.string(), z.number()]).optional(),
    sender_id: z.union([z.string(), z.number()]).optional(),
    senderId: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    sender_name: z.string().optional(),
    senderName: z.string().optional(),
    user_name: z.string().optional(),
    text: z.string().optional(),
    message: z.string().optional(),
    body: z.string().optional(),
  })
  .passthrough();

function asString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

/**
 * Normalize inbound chat JSON into a stable shape.
 * Generic mapping until the real vendor sample JSON arrives —
 * prefer snake_case (spec), fall back to camelCase / common aliases.
 */
export function parseChatMessage(body: unknown): ParsedChatMessage {
  const parsed = rawChatSchema.parse(body ?? {});
  const messageId =
    asString(parsed.message_id) ??
    asString(parsed.messageId) ??
    asString(parsed.id);
  const channelId =
    asString(parsed.channel_id) ?? asString(parsed.channelId);
  const senderId =
    asString(parsed.sender_id) ??
    asString(parsed.senderId) ??
    asString(parsed.user_id);
  const senderName =
    parsed.sender_name ??
    parsed.senderName ??
    parsed.user_name ??
    "unknown";
  const text = parsed.text ?? parsed.message ?? parsed.body ?? "";
  const threadId =
    asString(parsed.thread_id) ?? asString(parsed.threadId);

  if (!messageId || !channelId || !senderId) {
    throw new Error(
      "chat message missing required fields (message_id, channel_id, sender_id)",
    );
  }

  return {
    messageId,
    threadId,
    channelId,
    senderId,
    senderName,
    text: text.trim(),
  };
}

function mentionsDevbot(text: string): boolean {
  return /(^|\s)@devbot\b/i.test(text);
}

function stripMention(text: string): string {
  return text.replace(/(^|\s)@devbot\b/gi, " ").replace(/\s+/g, " ").trim();
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase();
}

async function processChatMessage(msg: ParsedChatMessage): Promise<void> {
  const config = loadConfig();

  if (msg.senderId === config.BOT_USER_ID) return;
  if (
    config.allowedUserIds.size > 0 &&
    !config.allowedUserIds.has(msg.senderId)
  ) {
    return;
  }

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

  if (!mentionsDevbot(msg.text)) return;

  const prompt = stripMention(msg.text) || msg.text;
  // Use message id as provisional thread if the chat vendor has no threads yet.
  const threadId = msg.threadId ?? msg.messageId;
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
    payload: { prompt, sender: msg.senderName },
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

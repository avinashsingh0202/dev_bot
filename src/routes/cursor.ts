/**
 * Cursor Cloud Agents webhook (raw body + HMAC signature).
 */
import express, { Router, type Request, type Response } from "express";
import { loadConfig } from "../config.js";
import {
  claimWebhookDelivery,
  findRequestByAgentId,
  logEvent,
  updateRequest,
} from "../db.js";
import { postMessage } from "../clients/chat.js";
import { verifyCursorSignature } from "../verify.js";
import { drainQueue } from "../queue.js";

interface CursorWebhookBody {
  id?: string;
  status?: string;
  event?: string;
  target?: {
    url?: string;
    branchName?: string;
    prUrl?: string;
  };
  summary?: string;
  error?: string | { message?: string };
}

function extractErrorMessage(body: CursorWebhookBody): string {
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && body.error.message) {
    return body.error.message;
  }
  return "unknown error";
}

async function handleStatusChange(body: CursorWebhookBody): Promise<void> {
  const agentId = body.id;
  if (!agentId) {
    console.warn("[cursor] statusChange missing agent id");
    return;
  }

  const request = await findRequestByAgentId(agentId);
  if (!request) {
    console.warn(`[cursor] no request for agent ${agentId}`);
    return;
  }

  const status = (body.status ?? "").toUpperCase();

  if (status === "FINISHED") {
    const prUrl = body.target?.prUrl ?? null;
    const summary = body.summary?.trim() || "(no summary)";

    if (prUrl) {
      await updateRequest(request.id, {
        status: "pr_open",
        pr_url: prUrl,
      });
      const msg = `PR opened: ${prUrl}\nSummary: ${summary}`;
      await postMessage(request.chat_channel, request.chat_thread, msg);
      await logEvent({
        requestId: request.id,
        type: "pr_open",
        source: "cursor",
        summary: msg,
        payload: body,
      });
    } else {
      await updateRequest(request.id, { status: "agent_error" });
      const msg = `${summary}\nPlease clarify what you need — reply in this thread.`;
      await postMessage(request.chat_channel, request.chat_thread, msg);
      await logEvent({
        requestId: request.id,
        type: "needs_clarification",
        source: "cursor",
        summary: msg,
        payload: body,
      });
    }
    await drainQueue();
    return;
  }

  if (status === "ERROR") {
    const errMsg = extractErrorMessage(body);
    await updateRequest(request.id, { status: "agent_error" });
    const msg = `Agent error: ${errMsg}\nReply retry to try again.`;
    await postMessage(request.chat_channel, request.chat_thread, msg);
    await logEvent({
      requestId: request.id,
      type: "agent_error",
      source: "cursor",
      summary: msg,
      payload: body,
    });
    await drainQueue();
  }
}

export function createCursorRouter(): Router {
  const router = Router();

  // express.raw so HMAC sees exact bytes (see build spec).
  router.post(
    "/webhooks/cursor",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const config = loadConfig();
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === "string" ? req.body : "");

        const signature = req.header("X-Webhook-Signature") ?? undefined;
        if (
          !verifyCursorSignature(
            rawBody,
            signature,
            config.CURSOR_WEBHOOK_SECRET,
          )
        ) {
          res.status(401).json({ ok: false, error: "invalid_signature" });
          return;
        }

        const deliveryId = req.header("X-Webhook-ID");
        if (deliveryId) {
          const isNew = await claimWebhookDelivery(`cursor:${deliveryId}`);
          if (!isNew) {
            res.status(200).json({ ok: true, deduped: true });
            return;
          }
        }

        let body: CursorWebhookBody;
        try {
          body = JSON.parse(rawBody.toString("utf8")) as CursorWebhookBody;
        } catch {
          console.error("[cursor] invalid JSON body");
          res.status(200).json({ ok: false, error: "bad_json" });
          return;
        }

        const event = body.event ?? "statusChange";
        if (event === "statusChange") {
          await handleStatusChange(body);
        }

        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[cursor] webhook handler error", err);
        res.status(200).json({ ok: false, error: "handler_error" });
      }
    },
  );

  return router;
}

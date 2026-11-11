/**
 * GitHub webhooks (raw body + X-Hub-Signature-256).
 * Matches requests by branch prefix `devbot/`.
 */
import express, { Router, type Request, type Response } from "express";
import { loadConfig } from "../config.js";
import {
  claimWebhookDelivery,
  findRequestByBranch,
  logEvent,
  updateRequest,
  type RequestRow,
} from "../db.js";
import { postMessage } from "../clients/chat.js";
import { sendFollowup } from "../clients/cursor.js";
import {
  collectFailedJobLogs,
  decideCiRetry,
} from "../clients/github.js";
import { verifyGitHubSignature } from "../verify.js";

async function handleWorkflowRun(
  payload: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig();
  const action = payload.action as string | undefined;
  const run = payload.workflow_run as
    | {
        id?: number;
        conclusion?: string | null;
        head_branch?: string;
        html_url?: string;
        status?: string;
      }
    | undefined;

  if (action !== "completed" || !run) return;

  const branch = run.head_branch;
  if (!branch || !branch.startsWith("devbot/")) return;

  const request = await findRequestByBranch(branch);
  if (!request) {
    console.warn(`[github] no request for branch ${branch}`);
    return;
  }

  if (run.conclusion === "success") {
    await updateRequest(request.id, { status: "ci_passed" });
    const msg = "CI passed, ready for review";
    await postMessage(request.chat_channel, request.chat_thread, msg);
    await logEvent({
      requestId: request.id,
      type: "ci_passed",
      source: "github",
      summary: msg,
      payload: { runId: run.id, url: run.html_url },
    });
    return;
  }

  if (run.conclusion === "failure") {
    await handleCiFailure(request, run.id!, run.html_url, config.MAX_CI_RETRIES);
  }
}

async function handleCiFailure(
  request: RequestRow,
  runId: number,
  runUrl: string | undefined,
  maxRetries: number,
): Promise<void> {
  const decision = decideCiRetry({
    ciAttempts: request.ci_attempts,
    maxRetries,
  });

  if (decision.shouldRetry) {
    await updateRequest(request.id, {
      status: "ci_failed",
      ci_attempts: decision.nextAttempts,
    });

    let logs = "(could not fetch logs)";
    try {
      logs = await collectFailedJobLogs(runId);
    } catch (err) {
      console.error("[github] log fetch failed", err);
    }

    if (request.agent_id) {
      await sendFollowup(
        request.agent_id,
        [
          "CI failed on this branch. Fix the failures and push to the same branch.",
          "Failed job log tails:",
          logs,
        ].join("\n\n"),
      );
    }

    await updateRequest(request.id, { status: "agent_running" });
    const msg = `CI failed, agent is fixing (${decision.nextAttempts}/${maxRetries})`;
    await postMessage(request.chat_channel, request.chat_thread, msg);
    await logEvent({
      requestId: request.id,
      type: "ci_retry",
      source: "github",
      summary: msg,
      payload: { runId, runUrl, attempt: decision.nextAttempts },
    });
    return;
  }

  await updateRequest(request.id, { status: "gave_up" });
  const msg = runUrl
    ? `CI still failing, needs a human\n${runUrl}`
    : "CI still failing, needs a human";
  await postMessage(request.chat_channel, request.chat_thread, msg);
  await logEvent({
    requestId: request.id,
    type: "gave_up",
    source: "github",
    summary: msg,
    payload: { runId, runUrl },
  });
}

async function handlePullRequest(
  payload: Record<string, unknown>,
): Promise<void> {
  const action = payload.action as string | undefined;
  const pr = payload.pull_request as
    | {
        merged?: boolean;
        html_url?: string;
        number?: number;
        head?: { ref?: string };
        user?: { login?: string };
        merged_by?: { login?: string } | null;
      }
    | undefined;

  if (action !== "closed" || !pr) return;

  const branch = pr.head?.ref;
  if (!branch || !branch.startsWith("devbot/")) return;

  const request = await findRequestByBranch(branch);
  if (!request) {
    console.warn(`[github] no request for PR branch ${branch}`);
    return;
  }

  if (pr.merged) {
    const who = pr.merged_by?.login ?? pr.user?.login ?? "someone";
    await updateRequest(request.id, {
      status: "merged",
      pr_url: pr.html_url ?? request.pr_url,
      pr_number: pr.number ?? request.pr_number,
    });
    const msg = `Merged by ${who}`;
    await postMessage(request.chat_channel, request.chat_thread, msg);
    await logEvent({
      requestId: request.id,
      type: "merged",
      source: "github",
      summary: msg,
      payload: { pr: pr.number, url: pr.html_url },
    });
    return;
  }

  await updateRequest(request.id, {
    status: "closed",
    pr_url: pr.html_url ?? request.pr_url,
    pr_number: pr.number ?? request.pr_number,
  });
  const msg = "PR closed without merging";
  await postMessage(request.chat_channel, request.chat_thread, msg);
  await logEvent({
    requestId: request.id,
    type: "closed",
    source: "github",
    summary: msg,
    payload: { pr: pr.number, url: pr.html_url },
  });
}

export function createGitHubRouter(): Router {
  const router = Router();

  // express.raw so HMAC sees exact bytes (see build spec).
  router.post(
    "/webhooks/github",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const config = loadConfig();
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === "string" ? req.body : "");

        const signature = req.header("X-Hub-Signature-256") ?? undefined;
        if (
          !verifyGitHubSignature(
            rawBody,
            signature,
            config.GITHUB_WEBHOOK_SECRET,
          )
        ) {
          res.status(401).json({ ok: false, error: "invalid_signature" });
          return;
        }

        const deliveryId = req.header("X-GitHub-Delivery");
        if (deliveryId) {
          const isNew = await claimWebhookDelivery(`github:${deliveryId}`);
          if (!isNew) {
            res.status(200).json({ ok: true, deduped: true });
            return;
          }
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawBody.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          console.error("[github] invalid JSON body");
          res.status(200).json({ ok: false, error: "bad_json" });
          return;
        }

        const event = req.header("X-GitHub-Event") ?? "";

        if (event === "workflow_run") {
          await handleWorkflowRun(payload);
        } else if (event === "pull_request") {
          await handlePullRequest(payload);
        }

        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[github] webhook handler error", err);
        res.status(200).json({ ok: false, error: "handler_error" });
      }
    },
  );

  return router;
}

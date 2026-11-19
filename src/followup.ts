/**
 * Deliver a related bug to an agent that already exists.
 *
 * Reuse this from chat (new @devbot report that pickRelatedRequest matched)
 * and from the Cursor webhook (flush reports that arrived while the agent
 * was still running). Do not launch a second agent for those reports —
 * launchAgent() in src/queue.ts is only for a bug that did not match.
 *
 * Several queued reports are sent as one follow-up so Cursor resumes once.
 */
import { postMessage } from "./clients/chat.js";
import { sendFollowup } from "./clients/cursor.js";
import {
  enqueuePendingFollowup,
  getRequestById,
  linkRequestThread,
  logEvent,
  takePendingFollowups,
  updateRequest,
  type RequestRow,
} from "./db.js";
import {
  buildRelatedFollowupPrompt,
  followupTiming,
  isAgentBusyError,
  isRetiredAgentError,
  type RelatedReport,
} from "./related.js";

export type RelatedRouteResult = "sent" | "queued" | "agent_gone";

/**
 * Pass one related report to the open request's agent.
 * Returns agent_gone when that agent no longer exists so the caller can
 * launch a fresh one. A busy agent is queued and flushed on the next
 * Cursor status webhook.
 */
export async function routeRelatedReport(input: {
  request: RequestRow;
  senderName: string;
  text: string;
  replyChannel: string;
  replyThread: string;
  reason: string;
}): Promise<RelatedRouteResult> {
  const report: RelatedReport = {
    senderName: input.senderName,
    text: input.text,
  };
  const timing = followupTiming(input.request.status);

  if (timing === "queue") {
    await holdReport(input.request, report);
    await rememberThread(input);
    // The run may have finished between the status check and this insert.
    // Flush now so the report does not wait for a webhook that already ran.
    const fresh = await getRequestById(input.request.id);
    if (fresh && followupTiming(fresh.status) === "send" && fresh.agent_id) {
      const flushed = await flushPendingFollowups(fresh);
      if (flushed) {
        if (input.replyThread !== input.request.chat_thread) {
          await postMessage(
            input.replyChannel,
            input.replyThread,
            sentSummary(fresh),
          );
        }
        return "sent";
      }
    }
    const summary = queuedSummary(input.request);
    await postMessage(input.replyChannel, input.replyThread, summary);
    await notifyOriginalThread(
      input,
      `Related report queued for this agent: "${input.text}"`,
    );
    await logEvent({
      requestId: input.request.id,
      type: "related_queued",
      source: "chat",
      summary,
      payload: { reason: input.reason, text: input.text },
    });
    return "queued";
  }

  const agentId = input.request.agent_id;
  if (!agentId) return "agent_gone";

  try {
    await sendFollowup(
      agentId,
      buildRelatedFollowupPrompt({
        branch: input.request.branch,
        reports: [report],
      }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isRetiredAgentError(detail)) {
      console.warn(`[followup] agent ${agentId} is gone: ${detail}`);
      return "agent_gone";
    }
    if (isAgentBusyError(detail)) {
      await holdReport(input.request, report);
      await rememberThread(input);
      const summary = queuedSummary(input.request);
      await postMessage(input.replyChannel, input.replyThread, summary);
      await logEvent({
        requestId: input.request.id,
        type: "related_queued",
        source: "chat",
        summary,
        payload: { reason: input.reason, text: input.text, detail },
      });
      return "queued";
    }
    throw err;
  }

  await updateRequest(input.request.id, { status: "agent_running" });
  await rememberThread(input);
  const summary = sentSummary(input.request);
  await postMessage(input.replyChannel, input.replyThread, summary);
  await notifyOriginalThread(
    input,
    `Related report added to this agent: "${input.text}"`,
  );
  await logEvent({
    requestId: input.request.id,
    type: "related_followup",
    source: "chat",
    summary,
    payload: { reason: input.reason, text: input.text, agentId },
  });
  return "sent";
}

/**
 * Send every related report that waited for this agent, as one follow-up.
 * Call this when a Cursor run reaches a terminal status, before starting
 * anything else on the launch queue.
 */
export async function flushPendingFollowups(
  request: RequestRow,
): Promise<boolean> {
  if (!request.agent_id) return false;
  const pending = await takePendingFollowups(request.id);
  if (pending.length === 0) return false;

  const reports = pending.map((row) => ({
    senderName: row.sender_name,
    text: row.text,
  }));

  try {
    await sendFollowup(
      request.agent_id,
      buildRelatedFollowupPrompt({
        branch: request.branch,
        reports,
      }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isRetiredAgentError(detail)) {
      const summary =
        "The previous agent is no longer available, so the related report was not sent. Mention @devbot again to start a fresh one.";
      await postMessage(request.chat_channel, request.chat_thread, summary);
      await logEvent({
        requestId: request.id,
        type: "related_dropped",
        source: "devbot",
        summary,
        payload: { detail },
      });
      return false;
    }
    // Transient failure: put the reports back. The next terminal webhook retries.
    for (const row of pending) {
      await enqueuePendingFollowup({
        requestId: request.id,
        senderName: row.sender_name,
        text: row.text,
      });
    }
    console.error("[followup] flush failed", err);
    return false;
  }

  await updateRequest(request.id, { status: "agent_running" });
  const summary = `Passed ${reports.length} related report${reports.length === 1 ? "" : "s"} to the same agent.`;
  await postMessage(request.chat_channel, request.chat_thread, summary);
  await logEvent({
    requestId: request.id,
    type: "related_followup",
    source: "devbot",
    summary,
    payload: { agentId: request.agent_id, count: reports.length },
  });
  return true;
}

async function holdReport(
  request: RequestRow,
  report: RelatedReport,
): Promise<void> {
  await enqueuePendingFollowup({
    requestId: request.id,
    senderName: report.senderName,
    text: report.text,
  });
  // Keep the row inside the related-bug lookback window while it waits.
  await updateRequest(request.id, { status: request.status });
}

async function rememberThread(input: {
  request: RequestRow;
  replyChannel: string;
  replyThread: string;
}): Promise<void> {
  if (!input.replyThread || input.replyThread === input.request.chat_thread) {
    return;
  }
  await linkRequestThread({
    chatChannel: input.replyChannel,
    chatThread: input.replyThread,
    requestId: input.request.id,
  });
}

async function notifyOriginalThread(
  input: {
    request: RequestRow;
    replyChannel: string;
    replyThread: string;
  },
  text: string,
): Promise<void> {
  if (
    !input.request.chat_thread ||
    input.request.chat_thread === input.replyThread
  ) {
    return;
  }
  await postMessage(input.request.chat_channel, input.request.chat_thread, text);
}

function sentSummary(request: RequestRow): string {
  const where = request.branch ? `branch ${request.branch}` : "the open fix";
  const pr = request.pr_url ? `\nPR: ${request.pr_url}` : "";
  return `This matches the open fix on ${where}, so I sent it to that same agent.${pr}\nReply in this thread to add detail.`;
}

function queuedSummary(request: RequestRow): string {
  const where = request.branch ? `branch ${request.branch}` : "the open fix";
  return `This matches the open fix on ${where}. That agent is still working, so I will pass this to it as soon as it is free.`;
}

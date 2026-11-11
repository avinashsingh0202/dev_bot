/**
 * Simple in-process queue: at most MAX_RUNNING agents at once.
 * Queued items post "Queued" then launch when a slot frees.
 * Reusable for Phase 2 if board-triggered launches share the same cap.
 */
import {
  countRunningAgents,
  logEvent,
  updateRequest,
  type RequestRow,
} from "./db.js";
import { launchAgent, buildAgentPrompt } from "./clients/cursor.js";
import { postMessage } from "./clients/chat.js";

const MAX_RUNNING = 3;

interface QueueItem {
  request: RequestRow;
  senderName: string;
  text: string;
}

const pending: QueueItem[] = [];
let draining = false;

export async function enqueueOrLaunch(item: QueueItem): Promise<void> {
  const running = await countRunningAgents();
  if (running >= MAX_RUNNING) {
    await postMessage(
      item.request.chat_channel,
      item.request.chat_thread,
      "Queued",
    );
    await logEvent({
      requestId: item.request.id,
      type: "queued",
      source: "devbot",
      summary: "Queued — waiting for an agent slot",
    });
    pending.push(item);
    return;
  }
  await startAgent(item);
}

async function startAgent(item: QueueItem): Promise<void> {
  const branch =
    item.request.branch ?? `devbot/${item.request.id.slice(0, 8)}`;
  const promptText = buildAgentPrompt(item.senderName, item.text);

  const launched = await launchAgent({ promptText, branchName: branch });
  const agentUrl = launched.target?.url;

  await updateRequest(item.request.id, {
    agent_id: launched.id,
    branch,
    status: "agent_running",
  });

  const msg = agentUrl
    ? `Agent started on branch ${branch}: ${agentUrl}`
    : `Agent started on branch ${branch}`;
  await postMessage(item.request.chat_channel, item.request.chat_thread, msg);
  await logEvent({
    requestId: item.request.id,
    type: "agent_started",
    source: "devbot",
    summary: msg,
    payload: { agentId: launched.id, branch, url: agentUrl },
  });
}

/** Call after an agent leaves agent_running so queued work can proceed. */
export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const running = await countRunningAgents();
      if (running >= MAX_RUNNING) break;
      const next = pending.shift();
      if (!next) break;
      try {
        await startAgent(next);
      } catch (err) {
        console.error("[queue] failed to start queued agent", err);
        await updateRequest(next.request.id, { status: "agent_error" });
        const summary = `Failed to start agent: ${String(err)}`;
        await postMessage(
          next.request.chat_channel,
          next.request.chat_thread,
          summary,
        );
        await logEvent({
          requestId: next.request.id,
          type: "agent_error",
          source: "devbot",
          summary,
        });
      }
    }
  } finally {
    draining = false;
  }
}

/** Test helper */
export function clearQueueForTests(): void {
  pending.length = 0;
  draining = false;
}

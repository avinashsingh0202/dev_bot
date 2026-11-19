/**
 * Cursor Cloud Agents v0 client.
 * Auth: Basic with CURSOR_API_KEY as username and empty password.
 */
import { loadConfig } from "../config.js";

const CURSOR_API = "https://api.cursor.com/v0";

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

export interface LaunchAgentInput {
  promptText: string;
  branchName: string;
}

export interface LaunchAgentResult {
  id: string;
  target?: {
    url?: string;
    branchName?: string;
    prUrl?: string;
  };
}

export function buildAgentPrompt(senderName: string, text: string): string {
  return [
    `You are DevBot fixing an issue reported by ${senderName} in team chat.`,
    `Report (may be informal or in any language): "${text}"`,
    "1. Find the root cause in the repo. 2. Make the smallest fix. 3. Add or",
    "update tests that prove it. 4. Run the tests. 5. Finish with a 3-5 line summary in",
    "English: root cause, change, how tested. If the report is too vague to act on,",
    "make no changes and explain what information is missing.",
  ].join("\n");
}

export async function launchAgent(
  input: LaunchAgentInput,
): Promise<LaunchAgentResult> {
  const config = loadConfig();
  const body: Record<string, unknown> = {
    prompt: { text: input.promptText },
    source: {
      repository: config.DEFAULT_REPO,
      ref: config.DEFAULT_REF,
    },
    target: {
      autoCreatePr: true,
      branchName: input.branchName,
    },
    webhook: {
      url: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/cursor`,
      secret: config.CURSOR_WEBHOOK_SECRET,
    },
  };
  if (config.CURSOR_MODEL) {
    body.model = config.CURSOR_MODEL;
  }

  const res = await fetch(`${CURSOR_API}/agents`, {
    method: "POST",
    headers: {
      Authorization: authHeader(config.CURSOR_API_KEY),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Cursor launchAgent failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }

  return (await res.json()) as LaunchAgentResult;
}

/**
 * Resume an existing agent. Prefer this over launchAgent when the bug is
 * the same one that agent already has — see src/followup.ts, which is the
 * single caller for related reports (it also batches queued ones).
 * Thread replies and CI retries call this directly on a known agent id.
 */
export async function sendFollowup(
  agentId: string,
  text: string,
): Promise<void> {
  const config = loadConfig();
  const res = await fetch(`${CURSOR_API}/agents/${agentId}/followup`, {
    method: "POST",
    headers: {
      Authorization: authHeader(config.CURSOR_API_KEY),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: { text } }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Cursor followup failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
}

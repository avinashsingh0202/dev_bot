/**
 * Generic chat outbound adapter.
 * Swap the POST body shape here when wiring a real chat vendor —
 * keep postMessage(channelId, threadId, text) as the stable surface.
 */
import { loadConfig } from "../config.js";

export async function postMessage(
  channelId: string,
  threadId: string | null | undefined,
  text: string,
): Promise<void> {
  const config = loadConfig();
  const body: Record<string, string> = {
    channel_id: channelId,
    text,
  };
  if (threadId) {
    body.thread_id = threadId;
  }

  const res = await fetch(config.CHAT_POST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.CHAT_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `chat postMessage failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
}

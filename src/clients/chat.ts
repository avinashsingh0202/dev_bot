/**
 * Outbound chat adapter (Isometrik send-message).
 *
 * CHAT_POST_URL must point at Isometrik's send-message API.
 * Keep postMessage(channelId, threadId, text) as the stable surface so
 * routes never depend on vendor field names.
 *
 * TODO(isometrik): confirm send-message request auth + JSON body shape.
 * We still need official docs for:
 *   - auth headers (license / project / user token — do not invent secrets)
 *   - whether conversationId + parentMessageId + body are the correct keys
 *   - any required messageType / deviceId / customType fields
 * Until then this posts a best-effort JSON body with Bearer CHAT_BOT_TOKEN.
 * See internal/isometrik-chat-mapping.md.
 */
import { loadConfig } from "../config.js";

export async function postMessage(
  channelId: string,
  threadId: string | null | undefined,
  text: string,
): Promise<void> {
  const config = loadConfig();

  // Best-effort Isometrik-oriented body; replace once send-message docs land.
  const body: Record<string, string> = {
    conversationId: channelId,
    body: text,
  };
  if (threadId) {
    // Reply in the same thread as the triggering message
    body.parentMessageId = threadId;
  }

  const res = await fetch(config.CHAT_POST_URL, {
    method: "POST",
    headers: {
      // TODO(isometrik): replace/extend with documented Isometrik auth headers
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

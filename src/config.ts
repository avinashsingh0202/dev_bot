/**
 * Central env loading. Keep all process.env reads here so adapters and
 * routes can reuse typed config without scattering validation.
 *
 * Production/dev boot: `src/server.ts` imports `dotenv/config` first so
 * `.env` is on process.env before loadConfig() runs. Do not import dotenv
 * here — tests call loadConfig(explicitEnv) and must stay side-effect free.
 */
import { z } from "zod";

/** Allow empty string or a URL (POC can omit chat outbound). */
const optionalUrl = z
  .string()
  .optional()
  .default("")
  .refine((v) => v === "" || z.string().url().safeParse(v).success, {
    message: "must be empty or a valid URL",
  });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  CURSOR_API_KEY: z.string().min(1),
  /** Optional; omit/blank → Cursor default model. */
  CURSOR_MODEL: z.string().optional().default(""),
  CURSOR_WEBHOOK_SECRET: z.string().min(32),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  DEFAULT_REPO: z.string().url(),
  DEFAULT_REF: z.string().min(1).default("main"),
  /** Optional for POC listen/trigger — missing skips outbound chat posts. */
  CHAT_POST_URL: optionalUrl,
  CHAT_BOT_TOKEN: z.string().optional().default(""),
  BOT_USER_ID: z.string().optional().default(""),
  /** Comma list; empty = allow all senders. POC default in .env.example. */
  ALLOWED_USER_IDS: z.string().optional().default(""),
  /** Comma list of conversationIds; empty = allow all. POC default in .env.example. */
  ALLOWED_CONVERSATION_IDS: z.string().optional().default(""),
  /**
   * Optional at boot so local `npm start` works before ngrok.
   * Empty/missing → http://localhost:3000 (Cursor/GitHub/Isometrik webhooks
   * still need a real public HTTPS URL — see warnLocalPublicBaseUrl).
   */
  PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().default("http://localhost:3000"),
  ),
  MAX_CI_RETRIES: z.coerce.number().int().nonnegative().default(2),
});

/** True when PUBLIC_BASE_URL is loopback — webhooks cannot reach it. */
export function isLocalPublicBaseUrl(url: string): boolean {
  try {
    // WHATWG hostname keeps the brackets on IPv6, so "[::1]" is loopback too.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true;
  }
}

/**
 * Startup warning when PUBLIC_BASE_URL is local/default.
 * Reuse from any entrypoint (server, scripts) after loadConfig().
 */
export function warnLocalPublicBaseUrl(publicBaseUrl: string): void {
  if (!isLocalPublicBaseUrl(publicBaseUrl)) return;
  console.warn(
    `[devbot] PUBLIC_BASE_URL is ${publicBaseUrl} (local default). ` +
      "Cursor, GitHub, and Isometrik webhooks need a real public HTTPS URL " +
      "(e.g. ngrok). Set PUBLIC_BASE_URL before registering webhook endpoints.",
  );
}

export type Config = z.infer<typeof envSchema> & {
  allowedUserIds: Set<string>;
  allowedConversationIds: Set<string>;
  /** True when both CHAT_POST_URL and CHAT_BOT_TOKEN are set. */
  chatOutboundEnabled: boolean;
};

let cached: Config | null = null;

function parseIdList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }

  const data = parsed.data;
  cached = {
    ...data,
    allowedUserIds: parseIdList(data.ALLOWED_USER_IDS),
    allowedConversationIds: parseIdList(data.ALLOWED_CONVERSATION_IDS),
    chatOutboundEnabled: Boolean(data.CHAT_POST_URL && data.CHAT_BOT_TOKEN),
  };
  // Warn once when config first loads with a loopback PUBLIC_BASE_URL.
  warnLocalPublicBaseUrl(cached.PUBLIC_BASE_URL);
  return cached;
}

/** Test helper — clear memoized config between cases. */
export function resetConfigCache(): void {
  cached = null;
}

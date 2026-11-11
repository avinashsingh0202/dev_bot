/**
 * Central env loading. Keep all process.env reads here so adapters and
 * routes can reuse typed config without scattering validation.
 */
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  CURSOR_API_KEY: z.string().min(1),
  CURSOR_MODEL: z.string().optional().default(""),
  CURSOR_WEBHOOK_SECRET: z.string().min(32),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  DEFAULT_REPO: z.string().url(),
  DEFAULT_REF: z.string().min(1).default("main"),
  CHAT_POST_URL: z.string().url(),
  CHAT_BOT_TOKEN: z.string().min(1),
  BOT_USER_ID: z.string().min(1),
  ALLOWED_USER_IDS: z.string().optional().default(""),
  PUBLIC_BASE_URL: z.string().url(),
  MAX_CI_RETRIES: z.coerce.number().int().nonnegative().default(2),
});

export type Config = z.infer<typeof envSchema> & {
  allowedUserIds: Set<string>;
};

let cached: Config | null = null;

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
  const allowedUserIds = new Set(
    data.ALLOWED_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  cached = { ...data, allowedUserIds };
  return cached;
}

/** Test helper — clear memoized config between cases. */
export function resetConfigCache(): void {
  cached = null;
}

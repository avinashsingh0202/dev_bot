/**
 * Shared fixtures for hermetic tests. No network, no Postgres.
 */
import http from "node:http";
import { createHmac } from "node:crypto";
import type { RequestRow } from "../src/db.js";

/** Required keys plus a public webhook base so loadConfig does not warn. */
export const testEnv: NodeJS.ProcessEnv = {
  PORT: "3000",
  DATABASE_URL: "postgres://devbot:devbot@localhost:5433/devbot",
  CURSOR_API_KEY: "cursor-key",
  CURSOR_MODEL: "",
  CURSOR_WEBHOOK_SECRET: "x".repeat(32),
  GITHUB_WEBHOOK_SECRET: "gh-secret",
  GITHUB_TOKEN: "gh-token",
  DEFAULT_REPO: "https://github.com/acme/app",
  DEFAULT_REF: "main",
  CHAT_POST_URL: "",
  CHAT_BOT_TOKEN: "",
  BOT_USER_ID: "",
  ALLOWED_USER_IDS: "",
  ALLOWED_CONVERSATION_IDS: "",
  PUBLIC_BASE_URL: "https://hooks.example.com",
  MAX_CI_RETRIES: "2",
};

export function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    chat_channel: "conv-1",
    chat_thread: "thread-1",
    requested_by: "user-1",
    requested_by_name: "Ada",
    prompt: "login button broken on checkout",
    repo: "https://github.com/acme/app",
    agent_id: "agent-1",
    branch: "devbot/11111111",
    pr_url: "https://github.com/acme/app/pull/4",
    pr_number: 4,
    status: "pr_open",
    ci_attempts: 0,
    board_card_id: null,
    created_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-02T00:00:00Z"),
    ...overrides,
  };
}

export function signBody(secret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function installFetch(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers);
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(recorded);
    return handler(recorded);
  };
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  statusText = "OK",
): Response {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(
  status: number,
  body: string,
  statusText = "OK",
): Response {
  return new Response(body, { status, statusText });
}

export async function withServer(
  app: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("expected a TCP port");
  }
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

/** Let an ack-then-process chat handler finish its microtasks. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

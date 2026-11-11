/**
 * Shared webhook signature helpers.
 * Mount Cursor/GitHub routes with express.raw so these see the exact bytes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Cursor: X-Webhook-Signature = "sha256=" + HMAC-SHA256(raw body, secret) */
export function verifyCursorSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signatureHeader);
}

/** GitHub: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, secret) */
export function verifyGitHubSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signatureHeader);
}

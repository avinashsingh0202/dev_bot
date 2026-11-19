import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  verifyCursorSignature,
  verifyGitHubSignature,
} from "../src/verify.js";

const SECRET = "test-webhook-secret-at-least-32-chars!!";
const BODY = Buffer.from('{"event":"statusChange","status":"FINISHED"}');

function sign(secret: string, body: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyCursorSignature", () => {
  it("accepts a valid signature", () => {
    const sig = sign(SECRET, BODY);
    assert.equal(verifyCursorSignature(BODY, sig, SECRET), true);
  });

  it("rejects a missing signature", () => {
    assert.equal(verifyCursorSignature(BODY, undefined, SECRET), false);
  });

  it("rejects a wrong secret", () => {
    const sig = sign("other-secret-other-secret-other!!", BODY);
    assert.equal(verifyCursorSignature(BODY, sig, SECRET), false);
  });

  it("rejects a tampered body", () => {
    const sig = sign(SECRET, BODY);
    assert.equal(
      verifyCursorSignature(Buffer.from('{"event":"nope"}'), sig, SECRET),
      false,
    );
  });
});

describe("verifyGitHubSignature", () => {
  it("accepts a valid X-Hub-Signature-256", () => {
    const sig = sign(SECRET, BODY);
    assert.equal(verifyGitHubSignature(BODY, sig, SECRET), true);
  });

  it("rejects an empty header", () => {
    assert.equal(verifyGitHubSignature(BODY, "", SECRET), false);
  });

  it("rejects a truncated signature", () => {
    const sig = sign(SECRET, BODY).slice(0, 20);
    assert.equal(verifyGitHubSignature(BODY, sig, SECRET), false);
  });

  it("accepts a string body and rejects a different-case digest", () => {
    const raw = '{"ok":true}';
    const sig = sign(SECRET, Buffer.from(raw));
    assert.equal(verifyCursorSignature(raw, sig, SECRET), true);
    assert.equal(verifyGitHubSignature(raw, sig, SECRET), true);
    const upperHex = sig.slice(0, 7) + sig.slice(7).toUpperCase();
    assert.equal(verifyGitHubSignature(raw, upperHex, SECRET), false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideCiRetry, lastLines } from "../src/clients/github.js";

describe("decideCiRetry", () => {
  it("retries while attempts are below max", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 0, maxRetries: 2 }), {
      shouldRetry: true,
      nextAttempts: 1,
    });
    assert.deepEqual(decideCiRetry({ ciAttempts: 1, maxRetries: 2 }), {
      shouldRetry: true,
      nextAttempts: 2,
    });
  });

  it("gives up once attempts reach max", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 2, maxRetries: 2 }), {
      shouldRetry: false,
      nextAttempts: 3,
    });
  });

  it("respects MAX_CI_RETRIES=0 (no auto fix)", () => {
    assert.deepEqual(decideCiRetry({ ciAttempts: 0, maxRetries: 0 }), {
      shouldRetry: false,
      nextAttempts: 1,
    });
  });
});

describe("lastLines", () => {
  it("keeps the last N lines for CI log tails", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    const tail = lastLines(text, 150);
    const lines = tail.split("\n");
    assert.equal(lines.length, 150);
    assert.equal(lines[0], "line-51");
    assert.equal(lines[149], "line-200");
  });

  it("returns the full text when shorter than the limit", () => {
    assert.equal(lastLines("a\nb\nc", 150), "a\nb\nc");
  });
});

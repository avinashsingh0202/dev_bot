import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRelatedFollowupPrompt,
  followupTiming,
  isAgentBusyError,
  isRetiredAgentError,
  pickRelatedRequest,
  stripFreshAgentPrefix,
  wantsFreshAgent,
  type RelatedCandidate,
} from "../src/related.js";

function candidate(
  overrides: Partial<RelatedCandidate> & Pick<RelatedCandidate, "id" | "prompt">,
): RelatedCandidate {
  return {
    branch: null,
    pr_url: null,
    pr_number: null,
    updated_at: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

describe("wantsFreshAgent", () => {
  it("treats a leading new as a fresh launch", () => {
    assert.equal(wantsFreshAgent("new login button is broken"), true);
    assert.equal(wantsFreshAgent("  NEW the signup page"), true);
    assert.equal(stripFreshAgentPrefix("new login button is broken"), "login button is broken");
  });

  it("leaves a normal report on the related-bug path", () => {
    assert.equal(wantsFreshAgent("login button is broken"), false);
    assert.equal(wantsFreshAgent("brand new page has no title"), false);
  });
});

describe("pickRelatedRequest", () => {
  const login = candidate({
    id: "11111111-1111-1111-1111-111111111111",
    prompt: "login button broken on checkout",
    branch: "devbot/11111111",
    pr_url: "https://github.com/acme/app/pull/12",
    pr_number: 12,
    updated_at: new Date("2026-11-02T00:00:00Z"),
  });
  const signup = candidate({
    id: "22222222-2222-2222-2222-222222222222",
    prompt: "signup page is slow on mobile",
    branch: "devbot/22222222",
    updated_at: new Date("2026-11-03T00:00:00Z"),
  });

  it("returns null when nothing is open or the report is blank", () => {
    assert.equal(pickRelatedRequest("login button broken", []), null);
    assert.equal(pickRelatedRequest("   ", [login]), null);
  });

  it("matches an explicit branch, PR, or id", () => {
    assert.equal(
      pickRelatedRequest("please look at devbot/11111111 again", [login, signup])?.id,
      login.id,
    );
    assert.equal(
      pickRelatedRequest("the failure is on https://github.com/acme/app/pull/12", [login])
        ?.reason,
      "explicit",
    );
    assert.equal(pickRelatedRequest("see PR 12", [login, signup])?.id, login.id);
    assert.equal(
      pickRelatedRequest("request 22222222 is the one", [login, signup])?.id,
      signup.id,
    );
    assert.equal(pickRelatedRequest("see #12", [login, signup])?.id, login.id);
    assert.equal(
      pickRelatedRequest("pull/12 failed", [login, signup])?.id,
      login.id,
    );
  });

  it("picks the newest request when the text names more than one", () => {
    const match = pickRelatedRequest(
      "see devbot/11111111 and devbot/22222222",
      [login, signup],
    );
    assert.equal(match?.id, signup.id);
    assert.equal(match?.reason, "explicit");
  });

  it("does not treat a short id as an explicit link", () => {
    const tiny = candidate({
      id: "short",
      prompt: "completely different words here",
    });
    assert.equal(pickRelatedRequest("short", [tiny]), null);
  });

  it("does not treat a shorter branch as a prefix of a longer one", () => {
    const short = candidate({
      id: "abcdef12-0000-0000-0000-000000000000",
      prompt: "unrelated words here",
      branch: "devbot/abcdef12",
    });
    assert.equal(
      pickRelatedRequest("branch devbot/abcdef1234 failed", [short]),
      null,
    );
  });

  it("reuses the agent when the reports share the same bug words", () => {
    const match = pickRelatedRequest(
      "the login button is still broken",
      [login, signup],
    );
    assert.equal(match?.id, login.id);
    assert.equal(match?.reason, "overlap");
  });

  it("starts a new agent when the words do not overlap enough", () => {
    assert.equal(
      pickRelatedRequest("payment webhook timeout", [login, signup]),
      null,
    );
    assert.equal(pickRelatedRequest("login page layout", [login]), null);
  });

  it("keeps a half-overlap and rejects a weaker one", () => {
    const half = candidate({
      id: "33333333-3333-3333-3333-333333333333",
      prompt: "alpha beta gamma delta",
    });
    const weaker = candidate({
      id: "33333333-3333-3333-3333-333333333334",
      prompt: "alpha beta gamma delta epsilon",
    });
    // 2 of 4 content words → score 0.5, which is the minimum.
    assert.equal(
      pickRelatedRequest("alpha beta other thing", [half])?.reason,
      "overlap",
    );
    // 2 of 5 content words → score 0.4, below the minimum.
    assert.equal(
      pickRelatedRequest("alpha beta other thing extra", [weaker]),
      null,
    );
  });

  it("prefers the newest equal overlap", () => {
    const older = candidate({
      id: "44444444-4444-4444-4444-444444444444",
      prompt: "password reset email missing",
      updated_at: new Date("2026-11-01T00:00:00Z"),
    });
    const newer = candidate({
      id: "55555555-5555-5555-5555-555555555555",
      prompt: "password reset email missing",
      updated_at: new Date("2026-11-10T00:00:00Z"),
    });
    assert.equal(
      pickRelatedRequest("password reset email missing", [older, newer])?.id,
      newer.id,
    );
  });

  it("attaches a vague same-bug note only when one request is open", () => {
    assert.equal(pickRelatedRequest("same bug, still broken", [login])?.reason, "only_open");
    assert.equal(pickRelatedRequest("same bug, still broken", [login, signup]), null);
  });

  it("lets an explicit link win over a closer word overlap", () => {
    const match = pickRelatedRequest(
      "login button broken on checkout, but the branch is devbot/22222222",
      [login, signup],
    );
    assert.equal(match?.id, signup.id);
    assert.equal(match?.reason, "explicit");
  });
});

describe("followup delivery helpers", () => {
  it("queues only while the agent is running", () => {
    assert.equal(followupTiming("agent_running"), "queue");
    assert.equal(followupTiming("pr_open"), "send");
    assert.equal(followupTiming("ci_failed"), "send");
  });

  it("recognises a retired agent separately from a busy one", () => {
    assert.equal(isRetiredAgentError("Cursor followup failed: 404 Not Found"), true);
    assert.equal(isRetiredAgentError("Cursor followup failed: 410 Gone"), true);
    assert.equal(isRetiredAgentError("agent expired"), true);
    assert.equal(isRetiredAgentError("Cursor followup failed: 400 branch not found"), false);
    assert.equal(isAgentBusyError("Cursor followup failed: 409 currently running"), true);
    assert.equal(isAgentBusyError("429 Too Many Requests"), true);
    assert.equal(isAgentBusyError("agent is in progress"), true);
    assert.equal(isAgentBusyError("busy"), true);
    assert.equal(isAgentBusyError("Cursor followup failed: 500"), false);
  });

  it("puts every waiting report in one follow-up prompt", () => {
    const prompt = buildRelatedFollowupPrompt({
      branch: "devbot/11111111",
      reports: [
        { senderName: "Ada", text: "login button still broken on mobile" },
        { senderName: "Grace", text: "same button fails after refresh" },
      ],
    });
    assert.match(prompt, /devbot\/11111111/);
    assert.match(prompt, /Ada: login button still broken on mobile/);
    assert.match(prompt, /Grace: same button fails after refresh/);
  });

  it("stays on the current branch when the request has none yet", () => {
    const prompt = buildRelatedFollowupPrompt({
      branch: null,
      reports: [{ senderName: "Ada", text: "still broken" }],
    });
    assert.match(prompt, /Stay on the current branch/);
    assert.match(prompt, /Ada: still broken/);
  });
});

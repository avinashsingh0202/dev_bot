/**
 * Decide whether a new bug report should reuse an open Cursor agent.
 *
 * Launching an agent is the costly step (fresh run, repo setup, full task).
 * A follow-up on an agent that already has the branch is the cheap path.
 * Use pickRelatedRequest() for the decision, then src/followup.ts to deliver
 * it — do not call launchAgent() for a match.
 *
 * Matching stays conservative on purpose: a wrong merge puts a second bug
 * on the wrong branch. A miss only costs one extra launch. Tune
 * MIN_SHARED_TOKENS and MIN_OVERLAP_SCORE here; both chat routing and tests
 * should keep importing these constants rather than copying the numbers.
 *
 * Escape hatch: a prompt that starts with "new" (after the @devbot prefix)
 * is always a fresh agent. See wantsFreshAgent().
 */

/** How long an open request stays eligible for a related follow-up. */
export const RELATED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Statuses whose agent can still accept a follow-up on the same branch.
 * merged / closed / stopped / gave_up are left out — that work is finished.
 */
export const REUSABLE_AGENT_STATUSES = [
  "agent_running",
  "pr_open",
  "ci_running",
  "ci_passed",
  "ci_failed",
  "agent_error",
] as const;

/** Content words that must be shared before two reports count as one bug. */
export const MIN_SHARED_TOKENS = 2;

/**
 * Overlap coefficient: shared words / smaller report.
 * 0.5 means at least half the shorter report shows up in the other.
 */
export const MIN_OVERLAP_SCORE = 0.5;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "our",
  "are",
  "was",
  "were",
  "been",
  "have",
  "this",
  "that",
  "with",
  "from",
  "your",
  "just",
  "please",
  "still",
  "about",
  "into",
  "also",
  "only",
  "some",
  "them",
  "they",
  "there",
  "here",
  "what",
  "need",
  "needs",
  "should",
  "would",
  "could",
  "does",
  "will",
  "can",
  "not",
  "but",
  "its",
  "dont",
  "all",
  "any",
  "out",
  "now",
  "how",
  "why",
  "who",
  "when",
]);

/** "same bug" / "still broken" with exactly one open request. */
const VAGUE_RELATED =
  /\b(same bug|same issue|same problem|related bug|related issue|this again|still happening|still broken)\b/i;

export interface RelatedCandidate {
  id: string;
  prompt: string;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  updated_at: Date;
}

export interface RelatedMatch {
  id: string;
  reason: "explicit" | "overlap" | "only_open";
  /** 1 for an explicit link or a single open bug; overlap coefficient otherwise. */
  score: number;
}

export interface RelatedReport {
  senderName: string;
  text: string;
}

/** `@devbot new …` forces a fresh agent even when the words overlap. */
export function wantsFreshAgent(text: string): boolean {
  return /^new\b/i.test(text.trim());
}

/** Drop the leading `new` so the agent prompt is the bug itself. */
export function stripFreshAgentPrefix(text: string): string {
  return text.trim().replace(/^new\b\s*/i, "").trim();
}

/**
 * Cursor follow-up is rejected while the agent is still running.
 * Queue in that case; send immediately for every other reusable status.
 */
export function followupTiming(status: string): "send" | "queue" {
  return status === "agent_running" ? "queue" : "send";
}

/**
 * Follow-up failed because that agent is gone — caller should launch a new one.
 * Match status codes only. A 400 body that happens to say "not found" is a
 * different failure and should stay on this agent.
 */
export function isRetiredAgentError(message: string): boolean {
  return /\b404\b|\b410\b|\bexpired\b/i.test(message);
}

/** Follow-up failed because the agent has not finished — queue and flush later. */
export function isAgentBusyError(message: string): boolean {
  return /\b409\b|\b429\b|currently running|in progress|\bbusy\b/i.test(message);
}

/**
 * Prompt for an existing agent. Lists every related report so several
 * queued notes become one follow-up (one resume, not several).
 */
export function buildRelatedFollowupPrompt(input: {
  branch: string | null;
  reports: RelatedReport[];
}): string {
  const where = input.branch
    ? `Stay on branch ${input.branch}.`
    : "Stay on the current branch.";
  const lines = input.reports.map((r) => `- ${r.senderName}: ${r.text}`);
  return [
    `Related report for the bug you are already working on. ${where}`,
    "Extend the current fix with the smallest extra change, update tests, and summarize in 3-5 lines.",
    "If a report is a different bug, leave the code unchanged and explain what is different.",
    "Reports:",
    ...lines,
  ].join("\n");
}

/**
 * Pick the open request this report belongs to, or null when it should
 * start its own agent. Explicit branch / PR / id beats word overlap.
 * Word overlap beats a vague "same bug" phrase, and that phrase only
 * attaches when there is exactly one open request.
 */
export function pickRelatedRequest(
  text: string,
  candidates: RelatedCandidate[],
): RelatedMatch | null {
  if (candidates.length === 0 || !text.trim()) return null;

  const explicit = candidates.filter((c) => mentionsCandidate(text, c));
  if (explicit.length > 0) {
    const best = mostRecent(explicit);
    return { id: best.id, reason: "explicit", score: 1 };
  }

  const incoming = contentTokens(text);
  let best: { candidate: RelatedCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const { shared, score } = overlap(incoming, contentTokens(candidate.prompt));
    if (shared < MIN_SHARED_TOKENS || score < MIN_OVERLAP_SCORE) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && isNewer(candidate, best.candidate))
    ) {
      best = { candidate, score };
    }
  }
  if (best) {
    return { id: best.candidate.id, reason: "overlap", score: best.score };
  }

  if (candidates.length === 1 && VAGUE_RELATED.test(text)) {
    return { id: candidates[0].id, reason: "only_open", score: 1 };
  }

  return null;
}

function mentionsCandidate(text: string, candidate: RelatedCandidate): boolean {
  if (candidate.branch && containsTerm(text, candidate.branch)) return true;
  if (candidate.pr_url && containsTerm(text, candidate.pr_url)) return true;
  if (candidate.pr_number != null) {
    const n = String(candidate.pr_number);
    const re = new RegExp(`(?:#|\\bpr\\s+|\\bpull/)${n}\\b`, "i");
    if (re.test(text)) return true;
  }
  const shortId = candidate.id.slice(0, 8);
  return shortId.length >= 8 && containsTerm(text, shortId);
}

/** Term match that does not treat a shorter id as a prefix of a longer one. */
function containsTerm(haystack: string, term: string): boolean {
  const hay = haystack.toLowerCase();
  const needle = term.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx < 0) return false;
  const after = haystack[idx + term.length];
  return after == null || /[^a-z0-9]/i.test(after);
}

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 3) continue;
    if (STOPWORDS.has(part)) continue;
    out.add(part);
  }
  return out;
}

function overlap(
  incoming: Set<string>,
  existing: Set<string>,
): { shared: number; score: number } {
  if (incoming.size === 0 || existing.size === 0) {
    return { shared: 0, score: 0 };
  }
  let shared = 0;
  for (const token of incoming) {
    if (existing.has(token)) shared += 1;
  }
  return { shared, score: shared / Math.min(incoming.size, existing.size) };
}

function mostRecent(candidates: RelatedCandidate[]): RelatedCandidate {
  return candidates.reduce((best, candidate) =>
    isNewer(candidate, best) ? candidate : best,
  );
}

function isNewer(candidate: RelatedCandidate, other: RelatedCandidate): boolean {
  return candidate.updated_at.getTime() >= other.updated_at.getTime();
}

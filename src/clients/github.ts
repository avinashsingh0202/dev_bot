/**
 * GitHub REST helpers shared by the CI webhook and the Cursor finish path.
 *
 * Reuse `ensurePullRequest()` when an agent pushes `devbot/…` but Cursor's
 * FINISHED webhook has no `target.prUrl`. It returns an existing open PR for
 * that head instead of opening a second one. Decision of *whether* to call it
 * lives in `planFinishedPullRequest()` (unit-tested, no network).
 *
 * Token scopes: `actions:read` for job logs, and pull-request write
 * (`pull_requests: write` on a fine-grained PAT, or `repo` on a classic PAT)
 * for `ensurePullRequest()`.
 */
import { loadConfig } from "../config.js";

function parseRepo(defaultRepo: string): { owner: string; repo: string } {
  // Accept https://github.com/org/repo or https://github.com/org/repo.git
  const match = defaultRepo.match(
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i,
  );
  if (!match) {
    throw new Error(`DEFAULT_REPO is not a GitHub URL: ${defaultRepo}`);
  }
  return { owner: match[1], repo: match[2] };
}

async function githubFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const config = loadConfig();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${config.GITHUB_TOKEN}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "devbot");

  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
  });
}

export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
}

export async function listFailedJobs(runId: number): Promise<WorkflowJob[]> {
  const config = loadConfig();
  const { owner, repo } = parseRepo(config.DEFAULT_REPO);
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `GitHub list jobs failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
  const data = (await res.json()) as { jobs?: WorkflowJob[] };
  return (data.jobs ?? []).filter((j) => j.conclusion === "failure");
}

/** Fetch job logs and keep the last `maxLines` lines (default 150). */
export async function getJobLogTail(
  jobId: number,
  maxLines = 150,
): Promise<string> {
  const config = loadConfig();
  const { owner, repo } = parseRepo(config.DEFAULT_REPO);
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `GitHub job logs failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
  const text = await res.text();
  return lastLines(text, maxLines);
}

export function lastLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

/**
 * What to do when a Cursor agent reports FINISHED.
 *
 * Launch already sets `autoCreatePr: true`. Cursor still sometimes pushes the
 * branch and omits `target.prUrl` — that case is `open_pr`, and
 * `ensurePullRequest()` does the GitHub call. No branch and no PR means the
 * agent made no commit (`clarify`).
 */
export function planFinishedPullRequest(input: {
  prUrl?: string | null;
  branchName?: string | null;
}):
  | { action: "record_pr"; prUrl: string }
  | { action: "open_pr"; branch: string }
  | { action: "clarify" } {
  const prUrl = input.prUrl?.trim() ?? "";
  if (prUrl) return { action: "record_pr", prUrl };
  const branch = input.branchName?.trim() ?? "";
  if (branch) return { action: "open_pr", branch };
  return { action: "clarify" };
}

/** One-line PR title from the chat prompt. Reused by the Cursor finish path. */
export function pullRequestTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim() || "change";
  const clipped = oneLine.length > 72 ? `${oneLine.slice(0, 69)}...` : oneLine;
  return `DevBot: ${clipped}`;
}

/** PR body. Reused by the Cursor finish path so the chat prompt stays on the PR. */
export function pullRequestBody(input: {
  prompt: string;
  summary?: string;
  agentUrl?: string;
}): string {
  const parts = ["Opened by DevBot."];
  const summary = input.summary?.trim();
  if (summary) parts.push(summary);
  parts.push(`Requested in chat: ${input.prompt.trim() || "(empty)"}`);
  if (input.agentUrl?.trim()) parts.push(`Agent: ${input.agentUrl.trim()}`);
  return parts.join("\n\n");
}

export type EnsurePullRequestResult =
  | { ok: true; number: number; htmlUrl: string; created: boolean }
  | { ok: false; reason: "no_commits" | "github_error"; detail: string };

interface GitHubPull {
  number?: number;
  html_url?: string;
  head?: { ref?: string };
}

/**
 * Open a PR for `head` against `base`, or return the open PR that already
 * uses that head. Call this only after `planFinishedPullRequest()` says
 * `open_pr` — do not call it when the webhook already included a PR URL.
 */
export async function ensurePullRequest(input: {
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<EnsurePullRequestResult> {
  const config = loadConfig();
  const { owner, repo } = parseRepo(config.DEFAULT_REPO);
  const existing = await findOpenPullRequest(owner, repo, input.head);
  if (existing) {
    return { ok: true, ...existing, created: false };
  }

  const res = await githubFetch(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    }),
  });
  const detail = await res.text().catch(() => "");
  if (res.ok) {
    const created = JSON.parse(detail) as GitHubPull;
    if (!created.number || !created.html_url) {
      return {
        ok: false,
        reason: "github_error",
        detail: "GitHub create PR response missing number or html_url",
      };
    }
    return {
      ok: true,
      number: created.number,
      htmlUrl: created.html_url,
      created: true,
    };
  }

  if (/no commits between/i.test(detail)) {
    return { ok: false, reason: "no_commits", detail: detail.trim() };
  }
  return {
    ok: false,
    reason: "github_error",
    detail: `${res.status} ${res.statusText} ${detail}`.trim(),
  };
}

/** Existing open PR whose head ref is `head`. Same-repo only. */
async function findOpenPullRequest(
  owner: string,
  repo: string,
  head: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${head}`,
  });
  const res = await githubFetch(`/repos/${owner}/${repo}/pulls?${query}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `GitHub list PRs failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
  const pulls = (await res.json()) as GitHubPull[];
  const match = pulls.find((pr) => pr.head?.ref === head && pr.number && pr.html_url);
  if (!match?.number || !match.html_url) return null;
  return { number: match.number, htmlUrl: match.html_url };
}

/**
 * Pure CI retry decision — unit-tested.
 * Returns whether to auto-retry and the attempt number after increment.
 */
export function decideCiRetry(input: {
  ciAttempts: number;
  maxRetries: number;
}): { shouldRetry: boolean; nextAttempts: number } {
  const nextAttempts = input.ciAttempts + 1;
  return {
    shouldRetry: input.ciAttempts < input.maxRetries,
    nextAttempts,
  };
}

export async function collectFailedJobLogs(runId: number): Promise<string> {
  const failed = await listFailedJobs(runId);
  if (failed.length === 0) {
    return `(no failed jobs found for run ${runId})`;
  }
  const chunks: string[] = [];
  for (const job of failed) {
    try {
      const tail = await getJobLogTail(job.id, 150);
      chunks.push(`--- job ${job.name} (${job.id}) ---\n${tail}`);
    } catch (err) {
      chunks.push(
        `--- job ${job.name} (${job.id}) ---\n(failed to fetch logs: ${String(err)})`,
      );
    }
  }
  return chunks.join("\n\n");
}

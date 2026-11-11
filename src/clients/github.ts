/**
 * Minimal GitHub REST helpers for CI failure log collection.
 * Token scopes needed: actions:read (job logs) on the sandbox repo.
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

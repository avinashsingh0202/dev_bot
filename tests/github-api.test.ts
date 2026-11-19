import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  collectFailedJobLogs,
  ensurePullRequest,
  getJobLogTail,
  listFailedJobs,
} from "../src/clients/github.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import {
  installFetch,
  jsonResponse,
  testEnv,
  textResponse,
  type RecordedRequest,
} from "./helpers.js";

function pathOf(url: string): { pathname: string; searchParams: URLSearchParams } {
  const parsed = new URL(url);
  return { pathname: parsed.pathname, searchParams: parsed.searchParams };
}

describe("GitHub API client", () => {
  let requests: RecordedRequest[];
  let restore: () => void;
  let handler: (req: RecordedRequest) => Response | Promise<Response>;

  beforeEach(() => {
    resetConfigCache();
    loadConfig({ ...testEnv });
    handler = () => jsonResponse(200, {});
    const installed = installFetch((req) => handler(req));
    requests = installed.requests;
    restore = installed.restore;
  });

  afterEach(() => {
    restore();
    resetConfigCache();
  });

  it("sends GitHub auth headers and keeps only failed jobs", async () => {
    handler = (req) => {
      assert.equal(req.headers.authorization, "Bearer gh-token");
      assert.equal(req.headers.accept, "application/vnd.github+json");
      assert.equal(req.headers["x-github-api-version"], "2022-11-28");
      assert.equal(req.headers["user-agent"], "devbot");
      return jsonResponse(200, {
        jobs: [
          { id: 1, name: "test", conclusion: "failure" },
          { id: 2, name: "lint", conclusion: "success" },
          { id: 3, name: "build", conclusion: null },
        ],
      });
    };
    const jobs = await listFailedJobs(55);
    assert.deepEqual(jobs, [{ id: 1, name: "test", conclusion: "failure" }]);
    assert.equal(
      pathOf(requests[0]!.url).pathname,
      "/repos/acme/app/actions/runs/55/jobs",
    );
  });

  it("returns an empty list when the jobs payload has none", async () => {
    handler = () => jsonResponse(200, {});
    assert.deepEqual(await listFailedJobs(1), []);
  });

  it("throws when listing jobs fails, even if the body cannot be read", async () => {
    handler = () => textResponse(404, "missing", "Not Found");
    await assert.rejects(
      listFailedJobs(1),
      /GitHub list jobs failed: 404 Not Found missing/,
    );
    handler = () =>
      ({
        ok: false,
        status: 500,
        statusText: "Err",
        text: async () => {
          throw new Error("reset");
        },
      }) as unknown as Response;
    await assert.rejects(listFailedJobs(1), /GitHub list jobs failed: 500 Err$/);
  });

  it("rejects a DEFAULT_REPO that is not a GitHub repository", async () => {
    resetConfigCache();
    loadConfig({ ...testEnv, DEFAULT_REPO: "https://example.com/acme/app" });
    await assert.rejects(
      listFailedJobs(1),
      /DEFAULT_REPO is not a GitHub URL: https:\/\/example.com\/acme\/app/,
    );
    assert.equal(requests.length, 0);
  });

  it("strips .git when building the API path", async () => {
    resetConfigCache();
    loadConfig({
      ...testEnv,
      DEFAULT_REPO: "https://github.com/acme/app.git",
    });
    handler = () => textResponse(200, "line-1\nline-2\nline-3");
    const tail = await getJobLogTail(9, 2);
    assert.equal(tail, "line-2\nline-3");
    assert.equal(
      pathOf(requests[0]!.url).pathname,
      "/repos/acme/app/actions/jobs/9/logs",
    );
  });

  it("throws when job logs cannot be fetched", async () => {
    handler = () => textResponse(403, "nope", "Forbidden");
    await assert.rejects(
      getJobLogTail(9),
      /GitHub job logs failed: 403 Forbidden nope/,
    );
  });

  it("returns an existing open pull request instead of creating one", async () => {
    handler = (req) => {
      if (req.method === "GET") {
        return jsonResponse(200, [
          { number: 3, html_url: "https://github.com/acme/app/pull/3", head: { ref: "other" } },
          {
            number: 8,
            html_url: "https://github.com/acme/app/pull/8",
            head: { ref: "devbot/abc" },
          },
        ]);
      }
      throw new Error("should not create a second PR");
    };
    const result = await ensurePullRequest({
      head: "devbot/abc",
      base: "main",
      title: "DevBot: fix",
      body: "body",
    });
    assert.deepEqual(result, {
      ok: true,
      number: 8,
      htmlUrl: "https://github.com/acme/app/pull/8",
      created: false,
    });
    assert.equal(requests.length, 1);
    const listed = pathOf(requests[0]!.url);
    assert.equal(listed.pathname, "/repos/acme/app/pulls");
    assert.equal(listed.searchParams.get("state"), "open");
    assert.equal(listed.searchParams.get("head"), "acme:devbot/abc");
  });

  it("opens a pull request when none is open for that head", async () => {
    handler = (req) => {
      if (req.method === "GET") return jsonResponse(200, []);
      assert.equal(req.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(req.body ?? ""), {
        title: "DevBot: fix",
        head: "devbot/abc",
        base: "develop",
        body: "body",
      });
      return textResponse(
        201,
        JSON.stringify({
          number: 9,
          html_url: "https://github.com/acme/app/pull/9",
        }),
        "Created",
      );
    };
    const result = await ensurePullRequest({
      head: "devbot/abc",
      base: "develop",
      title: "DevBot: fix",
      body: "body",
    });
    assert.deepEqual(result, {
      ok: true,
      number: 9,
      htmlUrl: "https://github.com/acme/app/pull/9",
      created: true,
    });
  });

  it("reports a create response that is missing the PR url", async () => {
    handler = (req) => {
      if (req.method === "GET") return jsonResponse(200, []);
      return textResponse(201, JSON.stringify({ number: 9 }), "Created");
    };
    const result = await ensurePullRequest({
      head: "devbot/abc",
      base: "main",
      title: "t",
      body: "b",
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "github_error",
      detail: "GitHub create PR response missing number or html_url",
    });
  });

  it("distinguishes no commits from other GitHub errors", async () => {
    handler = (req) => {
      if (req.method === "GET") return jsonResponse(200, []);
      return textResponse(
        422,
        "No commits between main and devbot/abc",
        "Unprocessable Entity",
      );
    };
    const empty = await ensurePullRequest({
      head: "devbot/abc",
      base: "main",
      title: "t",
      body: "b",
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.reason, "no_commits");
      assert.match(empty.detail, /No commits between/);
    }

    handler = (req) => {
      if (req.method === "GET") return jsonResponse(200, []);
      return textResponse(500, "boom", "Server Error");
    };
    const failed = await ensurePullRequest({
      head: "devbot/abc",
      base: "main",
      title: "t",
      body: "b",
    });
    assert.deepEqual(failed, {
      ok: false,
      reason: "github_error",
      detail: "500 Server Error boom",
    });
  });

  it("throws when listing open pull requests fails", async () => {
    handler = () => textResponse(401, "nope", "Unauthorized");
    await assert.rejects(
      ensurePullRequest({ head: "devbot/abc", base: "main", title: "t", body: "b" }),
      /GitHub list PRs failed: 401 Unauthorized nope/,
    );
  });

  it("joins failed job tails and keeps going when one log fetch fails", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
    handler = (req) => {
      if (req.url.includes("/jobs/2/logs")) {
        return textResponse(500, "nope", "Err");
      }
      if (req.url.includes("/logs")) return textResponse(200, lines);
      return jsonResponse(200, {
        jobs: [
          { id: 1, name: "test", conclusion: "failure" },
          { id: 2, name: "lint", conclusion: "failure" },
          { id: 3, name: "build", conclusion: "success" },
        ],
      });
    };
    const text = await collectFailedJobLogs(55);
    assert.match(text, /--- job test \(1\) ---/);
    assert.match(text, /line-10/);
    assert.match(text, /--- job lint \(2\) ---/);
    assert.match(text, /failed to fetch logs/);
    assert.doesNotMatch(text, /job build/);
  });

  it("says so when a failed run has no failed jobs", async () => {
    handler = () =>
      jsonResponse(200, {
        jobs: [{ id: 1, name: "test", conclusion: "success" }],
      });
    assert.equal(
      await collectFailedJobLogs(9),
      "(no failed jobs found for run 9)",
    );
    assert.equal(requests.length, 1);
  });

  it("propagates a jobs-list failure from the collector", async () => {
    handler = () => textResponse(500, "down", "Err");
    await assert.rejects(collectFailedJobLogs(9), /GitHub list jobs failed: 500/);
  });
});

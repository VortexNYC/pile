import { afterEach, describe, expect, it, vi } from "vitest";

import { handleLaneMcpRequest } from "../mcp/lane-server.js";
import {
  callLaneTool,
  createLaneGithub,
  LANE_CAPABILITIES,
  LANE_TOOLS,
  LaneToolError,
  laneToolsForTier,
  resolveLaneTier,
} from "./lane-tools.js";
import type {
  LaneGithub,
  LaneGithubRequest,
  LaneTier,
  LaneToolContext,
} from "./lane-tools.js";

interface Call {
  method: string;
  path: string;
  init?: LaneGithubRequest;
}

function fakeContext(
  tier: LaneTier,
  responses: Record<string, unknown> = {}
): { ctx: LaneToolContext; calls: Call[]; progress: string[] } {
  const calls: Call[] = [];
  const progress: string[] = [];
  const respond = (method: string, path: string) => {
    const key = `${method} ${path}`;
    if (!(key in responses)) throw new LaneToolError(`GitHub 404: ${key}`, 404);
    return responses[key];
  };
  const github: LaneGithub = {
    rest: async (method, path, init) => {
      calls.push({ method, path, init });
      return respond(method, path);
    },
    text: async (path, init) => {
      calls.push({ method: "GET", path, init });
      return String(respond("GET", path));
    },
    graphql: async (query, variables) => {
      calls.push({ method: "GRAPHQL", path: query, init: { body: variables } });
      return respond("GRAPHQL", query.trim().split(/[\s(]/u)[0] ?? "");
    },
  };
  return {
    calls,
    progress,
    ctx: {
      repo: "acme/widgets",
      branch: "issue-1",
      tier,
      github,
      mintPushToken: async () => "ghs_scoped",
      session: {
        reportProgress: async (message) => {
          progress.push(message);
        },
        setOutput: async () => {},
      },
    },
  };
}

function tierToolNames(tier: LaneTier): Set<string> {
  return new Set(laneToolsForTier(tier).map((tool) => tool.name));
}

const lanePr = {
  number: 7,
  html_url: "https://github.com/acme/widgets/pull/7",
  head: { ref: "issue-1", repo: { full_name: "acme/widgets" } },
};

describe("lane tool permissions", () => {
  it("defaults to the write tier and honors repo config", () => {
    expect(resolveLaneTier(null)).toBe("write");
    expect(resolveLaneTier({ lane: { tier: "read" } })).toBe("read");
  });

  it("gates tools per tier, each tier a superset of the one below", () => {
    const read = tierToolNames("read");
    const review = tierToolNames("review");
    const write = tierToolNames("write");
    const maintain = tierToolNames("maintain");

    expect(read.has("get_pull_request_diff")).toBe(true);
    expect(read.has("get_job_logs")).toBe(true);
    expect(read.has("create_issue_comment")).toBe(false);
    expect(review.has("create_pull_request_review")).toBe(true);
    expect(review.has("create_pull_request")).toBe(false);
    expect(write.has("create_pull_request")).toBe(true);
    expect(write.has("get_push_credential")).toBe(true);
    expect(write.has("merge_pull_request")).toBe(false);
    expect(maintain.has("merge_pull_request")).toBe(true);

    for (const [lower, upper] of [
      [read, review],
      [review, write],
      [write, maintain],
    ] as const) {
      for (const name of lower) expect(upper.has(name)).toBe(true);
    }
    expect(maintain.size).toBe(LANE_TOOLS.length);
  });

  it("covers every capability with at least one tool and has unique names", () => {
    const used = new Set(LANE_TOOLS.map((tool) => tool.capability));
    for (const capability of LANE_CAPABILITIES) {
      expect(used.has(capability)).toBe(true);
    }
    const names = LANE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("denies a tool outside the tier without touching GitHub", async () => {
    const { ctx, calls } = fakeContext("read");
    const result = await callLaneTool(ctx, "create_pull_request", {
      title: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("requires pr:write");
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown tools and invalid input", async () => {
    const { ctx } = fakeContext("maintain");
    expect((await callLaneTool(ctx, "run_shell", {})).ok).toBe(false);
    const bad = await callLaneTool(ctx, "get_pull_request", {
      pullNumber: "seven",
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("Invalid input for get_pull_request");
  });
});

describe("lane tool behavior", () => {
  it("opens PRs from the lane branch only", async () => {
    const { ctx, calls } = fakeContext("write", {
      "GET /repos/acme/widgets": { default_branch: "main" },
      "POST /repos/acme/widgets/pulls": lanePr,
    });
    const result = await callLaneTool(ctx, "create_pull_request", {
      title: "Fix it",
    });
    expect(result.ok).toBe(true);
    const create = calls.find((call) => call.method === "POST");
    expect(create?.init?.body).toMatchObject({
      head: "issue-1",
      base: "main",
      title: "Fix it",
    });
  });

  it("refuses to edit or merge a PR that isn't the lane's", async () => {
    const foreign = {
      ...lanePr,
      head: { ref: "someone-else", repo: { full_name: "acme/widgets" } },
    };
    const { ctx, calls } = fakeContext("maintain", {
      "GET /repos/acme/widgets/pulls/7": foreign,
    });
    for (const name of ["update_pull_request", "merge_pull_request"]) {
      const result = await callLaneTool(ctx, name, { pullNumber: 7 });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("not this lane's PR");
    }
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("merges the lane's own PR at the maintain tier", async () => {
    const { ctx, calls } = fakeContext("maintain", {
      "GET /repos/acme/widgets/pulls/7": lanePr,
      "PUT /repos/acme/widgets/pulls/7/merge": { merged: true },
    });
    const result = await callLaneTool(ctx, "merge_pull_request", {
      pullNumber: 7,
    });
    expect(result).toEqual({ ok: true, text: '{"merged":true}' });
    expect(calls.at(-1)?.init?.body).toEqual({
      merge_method: "squash",
      sha: undefined,
    });
  });

  it("scopes issue search to the lane repository", async () => {
    const { ctx, calls } = fakeContext("read", {
      "GET /search/issues": { items: [] },
    });
    await callLaneTool(ctx, "find_similar_issues", {
      query: "flaky login",
      state: "open",
    });
    expect(calls[0]?.init?.query?.q).toBe(
      "repo:acme/widgets is:issue is:open flaky login"
    );
  });

  it("returns a push credential and reports progress", async () => {
    const { ctx, progress } = fakeContext("write");
    const cred = await callLaneTool(ctx, "get_push_credential", {});
    expect(JSON.parse(cred.text)).toMatchObject({
      username: "x-access-token",
      token: "ghs_scoped",
      branch: "issue-1",
    });
    await callLaneTool(ctx, "report_progress", { message: "tests green" });
    expect(progress).toEqual(["tests green"]);
  });

  it("uploads a file onto the lane branch, updating when it exists", async () => {
    const path = "/repos/acme/widgets/contents/docs/shot%201.txt";
    const { ctx, calls } = fakeContext("write", {
      [`GET ${path}`]: { sha: "old" },
      [`PUT ${path}`]: {
        content: { path: "docs/shot 1.txt", download_url: "https://raw/x" },
        commit: { sha: "c1" },
      },
    });
    const result = await callLaneTool(ctx, "upload_file", {
      path: "docs/shot 1.txt",
      content: "héllo",
      message: "add shot",
    });
    expect(JSON.parse(result.text)).toEqual({
      path: "docs/shot 1.txt",
      url: "https://raw/x",
      commit: "c1",
    });
    expect(calls.at(-1)?.init?.body).toEqual({
      message: "add shot",
      branch: "issue-1",
      content: btoa(String.fromCharCode(...new TextEncoder().encode("héllo"))),
      sha: "old",
    });
    const denied = await callLaneTool(
      fakeContext("review").ctx,
      "upload_file",
      { path: "a", content: "b", message: "c" }
    );
    expect(denied.text).toContain("requires contents:write");
  });

  it("records the selected mode without widening the tier", async () => {
    const { ctx, progress } = fakeContext("read");
    const result = await callLaneTool(ctx, "select_mode", { mode: "review" });
    expect(JSON.parse(result.text)).toEqual({ mode: "review", tier: "read" });
    expect(progress).toEqual(["Mode: review"]);
  });

  it("tails job logs", async () => {
    const { ctx } = fakeContext("read", {
      "GET /repos/acme/widgets/actions/jobs/9/logs": "a\nb\nc\nd",
    });
    const result = await callLaneTool(ctx, "get_job_logs", {
      jobId: 9,
      tailLines: 2,
    });
    expect(JSON.parse(result.text)).toEqual({ text: "c\nd" });
  });
});

describe("createLaneGithub", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates, encodes queries, and maps errors", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ number: 1 }]))
      .mockResolvedValueOnce(
        Response.json({ message: "Not Found" }, { status: 404 })
      );
    const mint = vi.fn(async () => "ghs_full");
    const github = createLaneGithub(mint);

    await expect(
      github.rest("GET", "/repos/acme/widgets/pulls", {
        query: { state: "open", head: undefined },
      })
    ).resolves.toEqual([{ number: 1 }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.github.com/repos/acme/widgets/pulls?state=open"
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ghs_full"
    );

    await expect(
      github.rest("GET", "/repos/acme/widgets/pulls/404")
    ).rejects.toMatchObject({ status: 404, message: "GitHub 404: Not Found" });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("follows log redirects without the GitHub bearer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://blob.example/logs?sig=1" },
        })
      )
      .mockResolvedValueOnce(new Response("log line"));
    const github = createLaneGithub(async () => "ghs_full");
    await expect(
      github.text("/repos/acme/widgets/actions/jobs/1/logs")
    ).resolves.toBe("log line");
    expect(fetchSpy.mock.calls[1]).toEqual(["https://blob.example/logs?sig=1"]);
  });

  it("fails cleanly when no installation token can be minted", async () => {
    const github = createLaneGithub(async () => undefined);
    await expect(github.rest("GET", "/repos/acme/widgets")).rejects.toThrow(
      "No installation token for repository"
    );
  });
});

async function rpc(ctx: LaneToolContext, body: unknown) {
  const res = await handleLaneMcpRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
    }),
    ctx
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: {
      tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
      content?: { text: string }[];
      isError?: boolean;
    };
    error?: { message: string };
  };
}

describe("lane MCP server", () => {
  it("lists only the tools the tier grants", async () => {
    const { ctx } = fakeContext("review");
    const listed = await rpc(ctx, { method: "tools/list", params: {} });
    const listedNames = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(listedNames.toSorted()).toEqual(
      [...tierToolNames("review")].toSorted()
    );
    expect(listedNames).not.toContain("create_pull_request");
    const diff = listed.result?.tools?.find(
      (tool) => tool.name === "get_pull_request_diff"
    );
    expect(diff?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a granted tool and refuses an ungranted one", async () => {
    const { ctx } = fakeContext("read", {
      "GET /repos/acme/widgets/pulls/7": lanePr,
    });
    const ok = await rpc(ctx, {
      method: "tools/call",
      params: { name: "get_pull_request", arguments: { pullNumber: 7 } },
    });
    expect(ok.result?.isError).toBe(false);
    expect(ok.result?.content?.[0]?.text).toContain('"number":7');

    const denied = await rpc(ctx, {
      method: "tools/call",
      params: { name: "merge_pull_request", arguments: { pullNumber: 7 } },
    });
    const refused =
      denied.error !== undefined || denied.result?.isError === true;
    expect(refused).toBe(true);
  });
});

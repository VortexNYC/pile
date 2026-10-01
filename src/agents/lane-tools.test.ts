import { describe, expect, it } from "vitest";

import {
  allowedLaneTools,
  createLaneGithub,
  DEFAULT_LANE_TOOL_TIER,
  LANE_TOOLS,
  laneToolPolicy,
  laneToolPolicyForRepo,
  type LaneToolContext,
} from "./lane-tools.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mockGithub(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const ghFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = url.replace("https://api.github.com", "");
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    const value = routes[key];
    return new Response(
      typeof value === "string" ? value : JSON.stringify(value),
      { status: 200 }
    );
  };
  return { gh: createLaneGithub("ghs_test", ghFetch), calls };
}

function ctxFor(
  gh: LaneToolContext["gh"],
  reports: unknown[] = []
): LaneToolContext {
  return {
    gh,
    owner: "VortexNYC",
    repo: "pile",
    branch: "issue-PILE-284",
    policy: laneToolPolicy("maintain"),
    async report(input) {
      reports.push(input);
    },
  };
}

function tool(name: string) {
  const found = LANE_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

const LANE_PULL = {
  head: { ref: "issue-PILE-284", repo: { full_name: "VortexNYC/pile" } },
};
const OTHER_PULL = {
  head: { ref: "someone-else", repo: { full_name: "VortexNYC/pile" } },
};

const foreignThreadFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as { query: string };
  if (body.query.includes("resolveReviewThread")) {
    return Response.json({ data: { resolveReviewThread: { ok: true } } });
  }
  return Response.json({
    data: {
      node: {
        pullRequest: {
          headRefName: "someone-else",
          repository: { nameWithOwner: "VortexNYC/pile" },
        },
      },
    },
  });
};

describe("lane tool policy", () => {
  it("defaults to the contribute tier when no policy is configured", () => {
    const policy = laneToolPolicyForRepo(null, "VortexNYC/pile");
    expect(policy.tier).toBe(DEFAULT_LANE_TOOL_TIER);
    const names = allowedLaneTools(policy).map((t) => t.name);
    expect(names).toContain("create_pull_request");
    expect(names).toContain("resolve_review_thread");
    expect(names).not.toContain("rerun_failed_jobs");
  });

  it("resolves per-repo tiers, the * fallback, and per-tool denies", () => {
    const meta = {
      laneTools: {
        "*": "readonly",
        "VortexNYC/pile": { tier: "maintain", deny: ["update_pull_request"] },
      },
    };
    const readonly = laneToolPolicyForRepo(meta, "VortexNYC/other");
    expect(readonly.tier).toBe("readonly");
    const readonlyNames = allowedLaneTools(readonly).map((t) => t.name);
    expect(readonlyNames).toContain("get_pull_request");
    expect(readonlyNames).toContain("report_progress");
    expect(readonlyNames).not.toContain("create_pull_request");
    expect(readonlyNames).not.toContain("create_pull_request_review");

    const maintain = laneToolPolicyForRepo(meta, "VortexNYC/pile");
    const names = allowedLaneTools(maintain).map((t) => t.name);
    expect(names).toContain("rerun_failed_jobs");
    expect(names).not.toContain("update_pull_request");
  });

  it("ignores malformed policy entries", () => {
    expect(
      laneToolPolicyForRepo({ laneTools: { "a/b": "root" } }, "a/b").tier
    ).toBe(DEFAULT_LANE_TOOL_TIER);
    expect(
      laneToolPolicyForRepo({ laneTools: { "a/b": { tier: 7 } } }, "a/b").tier
    ).toBe(DEFAULT_LANE_TOOL_TIER);
  });

  it("gives every tool a declared permission and a unique name", () => {
    const names = LANE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("lane tools", () => {
  it("pins create_pull_request head to the lane branch and records the PR", async () => {
    const { gh, calls } = mockGithub({
      "GET /repos/VortexNYC/pile": { default_branch: "main" },
      "POST /repos/VortexNYC/pile/pulls": {
        number: 7,
        html_url: "https://github.com/VortexNYC/pile/pull/7",
      },
    });
    const reports: unknown[] = [];
    const out = await tool("create_pull_request").run(ctxFor(gh, reports), {
      title: "Lane tools",
    });
    expect(out).toEqual({
      number: 7,
      url: "https://github.com/VortexNYC/pile/pull/7",
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ head: "issue-PILE-284", base: "main" });
    expect(reports).toEqual([
      { prUrl: "https://github.com/VortexNYC/pile/pull/7" },
    ]);
  });

  it("refuses pr:write on a PR that is not the lane's own", async () => {
    const { gh, calls } = mockGithub({
      "GET /repos/VortexNYC/pile/pulls/9": OTHER_PULL,
    });
    await expect(
      tool("comment_on_pull_request").run(ctxFor(gh), {
        number: 9,
        body: "hi",
      })
    ).rejects.toThrow(/not this lane's PR/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("comments on the lane's own PR", async () => {
    const { gh, calls } = mockGithub({
      "GET /repos/VortexNYC/pile/pulls/3": LANE_PULL,
      "POST /repos/VortexNYC/pile/issues/3/comments": { id: 1 },
    });
    await tool("comment_on_pull_request").run(ctxFor(gh), {
      number: 3,
      body: "done",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      body: { body: "done" },
    });
  });

  it("blocks self-approval but allows reviewing other PRs", async () => {
    const { gh } = mockGithub({
      "GET /repos/VortexNYC/pile/pulls/3": LANE_PULL,
      "GET /repos/VortexNYC/pile/pulls/9": OTHER_PULL,
      "POST /repos/VortexNYC/pile/pulls/9/reviews": { id: 5 },
    });
    await expect(
      tool("create_pull_request_review").run(ctxFor(gh), {
        number: 3,
        event: "APPROVE",
      })
    ).rejects.toThrow(/cannot approve its own PR/);
    await expect(
      tool("create_pull_request_review").run(ctxFor(gh), {
        number: 9,
        event: "APPROVE",
      })
    ).resolves.toEqual({ id: 5 });
  });

  it("only resolves review threads on the lane's PR", async () => {
    await expect(
      tool("resolve_review_thread").run(
        ctxFor(createLaneGithub("t", foreignThreadFetch)),
        { threadId: "PRRT_1" }
      )
    ).rejects.toThrow(/not on this lane's PR/);
  });

  it("decodes file contents and rejects invalid input", async () => {
    const { gh } = mockGithub({
      "GET /repos/VortexNYC/pile/contents/src/a.ts?ref=main": {
        encoding: "base64",
        content: btoa("export const a = 1;\n"),
        sha: "abc",
      },
    });
    await expect(
      tool("get_file_contents").run(ctxFor(gh), {
        path: "src/a.ts",
        ref: "main",
      })
    ).resolves.toEqual({
      path: "src/a.ts",
      sha: "abc",
      content: "export const a = 1;\n",
    });
    await expect(
      tool("get_pull_request").run(ctxFor(gh), { number: -1 })
    ).rejects.toThrow();
  });

  it("restricts set_output prUrl to the lane repository", async () => {
    const { gh } = mockGithub({});
    const reports: unknown[] = [];
    await expect(
      tool("set_output").run(ctxFor(gh, reports), {
        prUrl: "https://github.com/evil/repo/pull/1",
      })
    ).rejects.toThrow(/prUrl must be a PR/);
    await tool("set_output").run(ctxFor(gh, reports), {
      result: "ok",
      prUrl: "https://github.com/VortexNYC/pile/pull/1",
    });
    expect(reports).toHaveLength(1);
  });
});

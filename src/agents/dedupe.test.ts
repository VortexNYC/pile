import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AgentSession, Issue } from "../types/workspace.js";
import { checkDispatchDedupe, titleTokens } from "./dedupe.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    organizationId: "org-1",
    teamId: "team-1",
    identifier: "ISS-42",
    title: "Emit invoice.paid webhook events",
    description: null,
    status: "backlog",
    priority: "medium",
    repo: "acme/widgets",
    branch: null,
    parentId: null,
    assigneeId: null,
    assigneeType: null,
    creatorId: "user-1",
    dueDate: null,
    estimate: null,
    sortOrder: 0,
    prUrl: null,
    prState: null,
    prCheckState: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Issue;
}

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "sess-1",
    organizationId: "org-1",
    issueId: "issue-other",
    agentId: "devin-cli",
    provider: "devin-cli",
    actorId: "user-1",
    actorType: "user",
    status: "running",
    result: null,
    url: null,
    providerSessionId: null,
    prUrl: null,
    prState: "open",
    branch: null,
    queuedAfter: null,
    parentSessionId: null,
    spawnDepth: 0,
    laneDbRef: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as AgentSession;
}

const pullsPayload = [
  {
    number: 740,
    html_url: "https://github.com/acme/widgets/pull/740",
    title: "ISS-42 invoice.paid emitter",
    body: "Implements the invoice.paid webhook for ISS-42",
    head: { ref: "iss-42-invoice-paid" },
  },
  {
    number: 741,
    html_url: "https://github.com/acme/widgets/pull/741",
    title: "unrelated refactor",
    body: null,
    head: { ref: "refactor" },
  },
];

function ghStub(extra: Record<string, unknown> = {}) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify(pullsPayload), { status: 200 });
    }
    for (const [key, value] of Object.entries(extra)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(value), { status: 200 });
      }
    }
    return new Response("[]", { status: 200 });
  };
}

const tokenForRepo = async () => "gh-token";
const noSessions = { listAgentSessions: async () => [] as AgentSession[] };

describe("titleTokens", () => {
  it("extracts significant deduped tokens", () => {
    expect(titleTokens("Emit invoice.paid webhook events")).toEqual(
      expect.arrayContaining(["emit", "invoice", "paid", "webhook", "events"])
    );
    expect(titleTokens("a an the")).toEqual([]);
  });
});

describe("checkDispatchDedupe", () => {
  it("returns empty result when the issue has no repo", async () => {
    const result = await checkDispatchDedupe(
      env,
      noSessions,
      makeIssue({ repo: null })
    );
    expect(result.coverage).toEqual([]);
    expect(result.hardBlock).toBeNull();
  });

  it("hard-blocks when an identifier-matched open PR has no live session", async () => {
    const result = await checkDispatchDedupe(env, noSessions, makeIssue(), {
      tokenForRepo,
      fetch: ghStub(),
    });
    expect(result.hardBlock?.prUrl).toBe(
      "https://github.com/acme/widgets/pull/740"
    );
    expect(result.queueAfter).toBeNull();
    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0].overlap).toBe("identifier");
  });

  it("queues behind the sibling session that owns the covering PR", async () => {
    const sibling = makeSession({
      id: "sess-owner",
      prUrl: "https://github.com/acme/widgets/pull/740",
    });
    const stub = { listAgentSessions: async () => [sibling] };
    const result = await checkDispatchDedupe(env, stub, makeIssue(), {
      tokenForRepo,
      fetch: ghStub(),
    });
    expect(result.queueAfter).toBe("sess-owner");
    expect(result.hardBlock).toBeNull();
  });

  it("flags file-surface collisions against sibling lane PRs", async () => {
    const sibling = makeSession({
      id: "sess-sibling",
      prUrl: "https://github.com/acme/widgets/pull/741",
      status: "running",
    });
    const stub = { listAgentSessions: async () => [sibling] };
    const files = [
      { filename: "src/billing/invoice.ts" },
      { filename: "src/webhooks/invoice-paid.ts" },
      { filename: "docs/readme.md" },
    ];
    const result = await checkDispatchDedupe(env, stub, makeIssue(), {
      tokenForRepo,
      fetch: ghStub({ "/pulls/741/files": files }),
    });
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].sessionId).toBe("sess-sibling");
    expect(result.collisions[0].files).toContain(
      "src/webhooks/invoice-paid.ts"
    );
  });

  it("does not block on keyword-only PR overlap", async () => {
    const keywordOnly = [
      {
        number: 742,
        html_url: "https://github.com/acme/widgets/pull/742",
        title: "emit invoice webhook refactor",
        body: "touches invoice emitters",
        head: { ref: "invoice-emit" },
      },
    ];
    const fetch2 = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls?state=open")) {
        return new Response(JSON.stringify(keywordOnly), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const result = await checkDispatchDedupe(env, noSessions, makeIssue(), {
      tokenForRepo,
      fetch: fetch2,
    });
    expect(result.hardBlock).toBeNull();
    expect(result.queueAfter).toBeNull();
    expect(result.coverage[0]?.overlap).toBe("keywords");
  });
});

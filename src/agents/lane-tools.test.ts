import { describe, expect, it } from "vitest";

import {
  allowedLaneTools,
  allowedWorkspaceLaneTools,
  createLaneGithub,
  DEFAULT_LANE_TOOL_TIER,
  LANE_TOOLS,
  type LaneWorkspace,
  laneToolPolicy,
  laneToolPolicyForRepo,
  WORKSPACE_LANE_TOOLS,
  type LaneToolContext,
  type WorkspaceLaneToolContext,
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

  it("set_plan publishes the whole checklist via ctx.report (PILE-426)", async () => {
    const { gh } = mockGithub({});
    const reports: unknown[] = [];
    const plan = [
      { content: "Read the issue", status: "completed" },
      { content: "Write the fix", status: "inProgress" },
    ];
    const out = await tool("set_plan").run(ctxFor(gh, reports), { plan });
    expect(out).toEqual({ ok: true, items: 2 });
    expect(reports).toEqual([{ plan }]);
    // Invalid statuses are rejected by the tool schema before reporting.
    await expect(
      tool("set_plan").run(ctxFor(gh, reports), {
        plan: [{ content: "x", status: "in_progress" }],
      })
    ).rejects.toThrow();
    expect(reports).toHaveLength(1);
    // Every lane tier can report — set_plan rides the lane:report grant.
    const readonly = laneToolPolicy("readonly");
    expect(allowedLaneTools(readonly).map((t) => t.name)).toContain("set_plan");
  });
});

describe("workspace lane tools — CRM surface", () => {
  const names = WORKSPACE_LANE_TOOLS.map((t) => t.name);
  it("registers the CRM/contact/suppression/market tools", () => {
    for (const n of [
      "customer_upsert",
      "contact_upsert",
      "suppress",
      "suppression_check",
      "market_run_report",
    ]) {
      expect(names).toContain(n);
    }
  });
  it("write tools carry ws:write, reads carry ws:read", () => {
    const byName = Object.fromEntries(
      WORKSPACE_LANE_TOOLS.map((t) => [t.name, t.permission])
    );
    expect(byName["customer_upsert"]).toBe("ws:write");
    expect(byName["contact_upsert"]).toBe("ws:write");
    expect(byName["suppress"]).toBe("ws:write");
    expect(byName["suppression_check"]).toBe("ws:read");
    expect(byName["market_run_report"]).toBe("ws:write");
  });
});

describe("workspace lane tools — merchant sources + fetch shelf", () => {
  const names = WORKSPACE_LANE_TOOLS.map((t) => t.name);
  it("registers the source + browse + data-source tools", () => {
    for (const n of [
      "source_add",
      "source_list",
      "source_collect",
      "browse",
      "socrata_query",
      "wayback",
      "serper_search",
      "usaspending",
      "sam_entities",
      "light_fetch",
      "obscura_fetch",
      "tech_fingerprint",
    ]) {
      expect(names).toContain(n);
    }
  });
});

// ---- workspace-domain tools (pipeline lanes) ----

interface FakeCustomer {
  id: string;
  name: string;
  domain: string | null;
  externalId: string | null;
  url: string | null;
  notes: string | null;
  priorityScore: number | null;
  customFields: Record<string, string>;
}

function fakeWorkspace(customers: FakeCustomer[] = []) {
  const calls = {
    createCustomer: [] as Record<string, unknown>[],
    updateCustomer: [] as {
      id: string;
      patch: Record<string, unknown>;
      actorId?: string;
    }[],
  };
  const ws: LaneWorkspace = {
    async getIssue() {
      return undefined;
    },
    async createComment() {
      return {};
    },
    async updateIssue() {
      return {};
    },
    async createCustomer(input) {
      calls.createCustomer.push(input);
      const record: FakeCustomer = {
        id: `cust-${customers.length + 1}`,
        name: input.name,
        domain: input.domain ?? null,
        externalId: input.externalId ?? null,
        url: null,
        notes: typeof input.notes === "string" ? input.notes : null,
        priorityScore: null,
        customFields: {},
      };
      customers.push(record);
      return record;
    },
    async getCustomer(id) {
      return customers.find((c) => c.id === id);
    },
    async getCustomerByDomain(domain) {
      return customers.find((c) => c.domain === domain);
    },
    async getCustomerByExternalId(externalId) {
      return customers.find((c) => c.externalId === externalId);
    },
    async updateCustomer(id, patch, actorId) {
      calls.updateCustomer.push({ id, patch, actorId });
      const customer = customers.find((c) => c.id === id);
      if (!customer) return undefined;
      const { customFields, ...scalars } = patch;
      Object.assign(customer, scalars);
      for (const [key, value] of Object.entries(customFields ?? {})) {
        if (value === null) {
          delete customer.customFields[key];
        } else {
          customer.customFields[key] = value;
        }
      }
      return customer;
    },
    async listCustomers() {
      return customers;
    },
    async getDocument() {
      return undefined;
    },
    async listDocuments() {
      return [];
    },
    async createDocument() {
      return { id: "doc-1" };
    },
    async updateDocument() {
      return {};
    },
    async memoryRemember() {
      return {};
    },
    async memoryRecall() {
      return [];
    },
  };
  return { ws, calls, customers };
}

function wsCtx(ws: LaneWorkspace): WorkspaceLaneToolContext {
  return {
    ws,
    organizationId: "org_vortex_main",
    sessionId: "sess-1",
    issueId: "issue-1",
    agentSlug: "profiler",
    async report() {},
    policy: laneToolPolicy("pipeline"),
  };
}

function wsTool(name: string) {
  const found = WORKSPACE_LANE_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("workspace lane tools", () => {
  it("customer_update is granted to the pipeline tier", () => {
    const names = allowedWorkspaceLaneTools(laneToolPolicy("pipeline")).map(
      (t) => t.name
    );
    expect(names).toContain("customer_update");
    expect(names).toContain("customer_upsert");
  });

  it("fills empty fields on a customer found by externalId", async () => {
    const { ws, calls, customers } = fakeWorkspace([
      {
        id: "cust-1",
        name: "Joe's Pizza",
        domain: null,
        externalId: "gplace:abc",
        url: null,
        notes: "[sourced-by:scout session:s-0]",
        priorityScore: null,
        customFields: {},
      },
    ]);
    const out = (await wsTool("customer_update").run(wsCtx(ws), {
      externalId: "gplace:abc",
      domain: "joespizza.example.com",
      url: "https://joespizza.example.com",
      priorityScore: 8,
      customFields: { industry: "restaurant", pos: "square" },
    })) as {
      updated: boolean;
      applied: string[];
      skipped: string[];
      customer: FakeCustomer;
    };
    expect(out.updated).toBe(true);
    expect(out.applied).toEqual([
      "domain",
      "url",
      "priorityScore",
      "customFields.industry",
      "customFields.pos",
    ]);
    expect(out.skipped).toEqual([]);
    expect(calls.updateCustomer).toEqual([
      {
        id: "cust-1",
        actorId: "profiler",
        patch: {
          domain: "joespizza.example.com",
          url: "https://joespizza.example.com",
          priorityScore: 8,
          customFields: { industry: "restaurant", pos: "square" },
        },
      },
    ]);
    expect(customers[0].domain).toBe("joespizza.example.com");
    expect(customers[0].customFields.pos).toBe("square");
  });

  it("never clobbers a non-empty value unless overwrite is passed", async () => {
    const { ws, calls, customers } = fakeWorkspace([
      {
        id: "cust-1",
        name: "Joe's Pizza",
        domain: "joespizza.example.com",
        externalId: "gplace:abc",
        url: null,
        notes: "human note",
        priorityScore: null,
        customFields: { pos: "square" },
      },
    ]);
    const out = (await wsTool("customer_update").run(wsCtx(ws), {
      id: "cust-1",
      domain: "different.example.com",
      notes: "profiler notes",
      customFields: { pos: "toast", size: "1-10" },
    })) as { updated: boolean; applied: string[]; skipped: string[] };
    expect(out.updated).toBe(true);
    expect(out.applied).toEqual(["customFields.size"]);
    expect(out.skipped).toEqual(["domain", "notes", "customFields.pos"]);
    expect(calls.updateCustomer[0].patch).toEqual({
      customFields: { size: "1-10" },
    });
    expect(customers[0].domain).toBe("joespizza.example.com");
    expect(customers[0].customFields.pos).toBe("square");

    const forced = (await wsTool("customer_update").run(wsCtx(ws), {
      id: "cust-1",
      domain: "different.example.com",
      overwrite: true,
    })) as { updated: boolean; applied: string[] };
    expect(forced.applied).toEqual(["domain"]);
    expect(customers[0].domain).toBe("different.example.com");
  });

  it("reports same-value fields as alreadySet and writes nothing", async () => {
    const { ws, calls } = fakeWorkspace([
      {
        id: "cust-1",
        name: "Joe's Pizza",
        domain: "joespizza.example.com",
        externalId: "gplace:abc",
        url: null,
        notes: null,
        priorityScore: null,
        customFields: { industry: "restaurant" },
      },
    ]);
    const out = (await wsTool("customer_update").run(wsCtx(ws), {
      externalId: "gplace:abc",
      domain: "joespizza.example.com",
      customFields: { industry: "restaurant" },
    })) as { updated: boolean; applied: string[]; alreadySet: string[] };
    expect(out.updated).toBe(false);
    expect(out.applied).toEqual([]);
    expect(out.alreadySet).toEqual(["domain", "customFields.industry"]);
    expect(calls.updateCustomer).toHaveLength(0);
  });

  it("requires exactly one lookup key and a real customer", async () => {
    const { ws } = fakeWorkspace([
      {
        id: "cust-1",
        name: "Joe's Pizza",
        domain: null,
        externalId: "gplace:abc",
        url: null,
        notes: null,
        priorityScore: null,
        customFields: {},
      },
    ]);
    await expect(
      wsTool("customer_update").run(wsCtx(ws), { domain: "x.example.com" })
    ).rejects.toThrow(/exactly one of id \/ externalId/);
    await expect(
      wsTool("customer_update").run(wsCtx(ws), {
        id: "cust-1",
        externalId: "gplace:abc",
        domain: "x.example.com",
      })
    ).rejects.toThrow(/exactly one of id \/ externalId/);
    await expect(
      wsTool("customer_update").run(wsCtx(ws), {
        externalId: "gplace:missing",
        domain: "x.example.com",
      })
    ).rejects.toThrow(/customer not found/);
  });

  it("customer_upsert still dedupes on match without writing (PILE-402)", async () => {
    const existing: FakeCustomer = {
      id: "cust-1",
      name: "Joe's Pizza",
      domain: null,
      externalId: "gplace:abc",
      url: null,
      notes: null,
      priorityScore: null,
      customFields: {},
    };
    const { ws, calls, customers } = fakeWorkspace([existing]);
    const out = (await wsTool("customer_upsert").run(wsCtx(ws), {
      name: "Joe's Pizza",
      externalId: "gplace:abc",
      notes: "enrichment ignored by upsert",
    })) as { created: boolean; customer: FakeCustomer };
    expect(out.created).toBe(false);
    expect(out.customer.id).toBe("cust-1");
    expect(calls.createCustomer).toHaveLength(0);
    expect(calls.updateCustomer).toHaveLength(0);
    expect(customers).toHaveLength(1);
    expect(customers[0].domain).toBeNull();
  });
});

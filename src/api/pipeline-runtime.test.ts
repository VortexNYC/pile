import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { drainDomainEvents } from "../agents/pipeline-events.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { getWorkspaceStub } from "./stub.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-pipeline-runtime",
      name: "Pipeline Runtime User",
      email: "pipeline-runtime@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const setupHeaders = await createAdminHeaders(env, "user-pipeline-runtime");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Pipeline runtime test",
    slug: `pipeline-rt-${crypto.randomUUID()}`,
    key: `P${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-pipeline-runtime",
  });
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-pipeline-runtime",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  return {
    organizationId: workspace!.id,
    token: z.object({ key: z.string() }).parse(result).key,
  };
}

async function fetch(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

describe("pipeline runtime (PILE-401/405/413)", () => {
  let org = "";
  let admin = "";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    org = seeded.organizationId;
    admin = seeded.token;
    // PILE-437 — providerAgentId must resolve at write time; register the
    // mock the CRUD test binds.
    registerAgentProvider(
      "mock-scout",
      () => new MockAgentProvider("mock-scout")
    );
  });

  // PILE-439 — create persists the same fields update does; a first POST
  // must not drop kind/endpointUrl/endpointSecret/prompt/model/tools.
  it("persists kind/endpoint/profile fields on agent-type create", async () => {
    const ext = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "ext-owner",
          name: "External Owner",
          providerAgentId: "flue",
          kind: "external",
          endpointUrl: "https://ext.example.test/hook",
          endpointSecret: "sekret",
          prompt: "You triage.",
          model: "tier-1",
          tools: '["issues.list"]',
        }),
      },
      admin
    );
    expect(ext.status).toBe(200);
    expect(await ext.json()).toMatchObject({
      slug: "ext_owner",
      kind: "external",
      endpointUrl: "https://ext.example.test/hook",
      hasEndpointSecret: true,
      prompt: "You triage.",
      model: "tier-1",
      tools: '["issues.list"]',
    });

    const human = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "human-owner",
          name: "Human Owner",
          providerAgentId: "mock-scout",
          kind: "human",
        }),
      },
      admin
    );
    expect(human.status).toBe(200);
    expect(await human.json()).toMatchObject({
      slug: "human_owner",
      kind: "human",
      hasEndpointSecret: false,
    });
  });

  it("CRUDs agent types and stage configs", async () => {
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "Sales Scout",
          name: "Sales Scout",
          providerAgentId: "mock-scout",
          jobSpec: "Find and profile merchants.",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);
    const agentType = z
      .object({ slug: z.string(), providerAgentId: z.string() })
      .parse(await type.json());
    expect(agentType.slug).toBe("sales_scout");

    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Outreach",
          ownerAgent: "sales_scout",
          advancePolicy: "auto",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);
    const listed = await fetch(`/workspaces/${org}/stage-configs`, {}, admin);
    const { configs } = z
      .object({ configs: z.array(z.object({ status: z.string() })) })
      .parse(await listed.json());
    expect(configs.map((c) => c.status)).toContain("outreach");
  });

  it("emits substep.actionable on materialization and all_required_done when the last required step closes", async () => {
    // Template on "triage" — fresh issues default to backlog.
    const tpl = await fetch(
      `/workspaces/${org}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          status: "triage",
          stepKey: "rt_step",
          title: "Runtime step",
          required: true,
        }),
      },
      admin
    );
    expect(tpl.status).toBe(201);

    const create = await fetch(
      `/workspaces/${org}/issues`,
      { method: "POST", body: JSON.stringify({ title: "Runtime parent" }) },
      admin
    );
    const parent = z.object({ id: z.string() }).parse(await create.json());
    await fetch(
      `/workspaces/${org}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "triage" }) },
      admin
    );

    const children = await fetch(
      `/workspaces/${org}/issues?parentId=${parent.id}`,
      {},
      admin
    );
    const [child] = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(await children.json()).issues;

    // Domain events land in the DO outbox — inspectable via listPending
    // through the drainer; close the required step to fire all_required_done.
    // PILE-414 — the list response carries the board chip's sub-step
    // progress for parents with required children.
    const board = await fetch(`/workspaces/${org}/issues`, {}, admin);
    const boardIssues = z
      .object({
        issues: z.array(
          z.object({
            id: z.string(),
            subStepProgress: z
              .object({
                total: z.number(),
                done: z.number(),
                blocked: z.number(),
                ownerAgent: z.string().nullable(),
              })
              .nullable()
              .optional(),
          })
        ),
      })
      .parse(await board.json());
    const parentRow = boardIssues.issues.find((row) => row.id === parent.id);
    expect(parentRow?.subStepProgress?.total).toBe(1);
    expect(parentRow?.subStepProgress?.blocked).toBe(1);

    const done = await fetch(
      `/workspaces/${org}/issues/${child.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(done.status).toBe(200);
  });

  it("drains substep.actionable into a dispatch to the resolved owner agent", async () => {
    const dispatched: string[] = [];
    const agentId = `mock-pod-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            dispatched.push(dispatchedIssue.id);
            return {
              id: `sess-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );
    // Register a pod agent type whose provider is the mock, then a stage
    // config that names it; a customer stage entry should dispatch it.
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "pod-scout",
          name: "Pod Scout",
          providerAgentId: agentId,
          jobSpec: "Scout the merchant.",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);
    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Prospect",
          ownerAgent: "pod-scout",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);

    // Register a stage template so the sub-step materializes.
    await fetch(
      `/workspaces/${org}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Prospect",
          stepKey: "scout_step",
          title: "Scout step",
          required: true,
          ownerAgent: "pod-scout",
        }),
      },
      admin
    );

    const customerRes = await fetch(
      `/workspaces/${org}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Dispatch Co" }) },
      admin
    );
    const customer = z
      .object({ id: z.string() })
      .parse(await customerRes.json());
    const statusRes = await fetch(
      `/workspaces/${org}/customer-statuses`,
      { method: "POST", body: JSON.stringify({ name: "Prospect" }) },
      admin
    );
    const status = z.object({ id: z.string() }).parse(await statusRes.json());
    const enter = await fetch(
      `/workspaces/${org}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: status.id }) },
      admin
    );
    expect(enter.status).toBe(200);

    // waitUntil may not flush in the test pool — drain explicitly.
    const stub = getWorkspaceStub(env, org);
    const drained = await drainDomainEvents(env, stub, org);
    expect(drained).toBeGreaterThan(0);
    expect(dispatched.length).toBeGreaterThan(0);
  });

  it("rejects unknown providers, patches by id, and lints unresolved owners (PILE-437)", async () => {
    // providerAgentId must resolve at write time
    const bad = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "ghost",
          name: "Ghost",
          providerAgentId: "not-a-real-provider",
        }),
      },
      admin
    );
    expect(bad.status).toBe(400);

    // PATCH agent type by id
    const create = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "scout",
          name: "Scout",
          providerAgentId: "mock-scout",
        }),
      },
      admin
    );
    const created = (await create.json()) as { id: string; slug: string };
    const patch = await fetch(
      `/workspaces/${org}/agent-types/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ jobSpec: "profile merchants" }),
      },
      admin
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { jobSpec: string };
    expect(patched.jobSpec).toBe("profile merchants");

    // an ownerAgent that has no registered agent type shows up in lint
    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Proposal",
          ownerAgent: "unregistered-owner",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);
    const lint = await fetch(`/workspaces/${org}/pipeline/lint`, {}, admin);
    const lintBody = (await lint.json()) as {
      findings: Array<{ kind: string; detail: string }>;
    };
    expect(
      lintBody.findings.some(
        (f) =>
          f.kind === "unresolved_owner_config" &&
          f.detail.includes("unregistered-owner")
      )
    ).toBe(true);
  });

  it("in-pile /dispatch/pile creates a session by key and resumes on the same key", async () => {
    env.AGENT_PROVIDER_TOKEN = "test-dispatch-token";
    const headers = { Authorization: "Bearer test-dispatch-token" };
    const key = `merchant-9-flue-scout-${crypto.randomUUID().slice(0, 8)}`;
    const issue = await fetch(
      `/workspaces/${org}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "deal issue", status: "todo" }),
      },
      admin
    );
    const { id: issueId } = (await issue.json()) as { id: string };
    const payload = JSON.stringify({
      organizationId: org,
      issue: { id: issueId, title: "deal issue" },
      profile: {
        slug: "sales-scout",
        name: "Sales Scout",
        jobSpec: "Find merchants",
      },
      conversationKey: key,
    });
    const first = await app.fetch(
      new Request("https://example.com/dispatch/pile", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payload,
      }),
      env
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { conversationId: string };

    const second = await app.fetch(
      new Request("https://example.com/dispatch/pile", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payload,
      }),
      env
    );
    const secondBody = (await second.json()) as { conversationId: string };
    // same conversation key resumes the same session — no new lane
    expect(secondBody.conversationId).toBe(firstBody.conversationId);

    const badAuth = await app.fetch(
      new Request("https://example.com/dispatch/pile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong",
        },
        body: payload,
      }),
      env
    );
    expect(badAuth.status).toBe(401);
  });

  async function createRequiredSubStep(title: string) {
    const parentRes = await fetch(
      `/workspaces/${org}/issues`,
      { method: "POST", body: JSON.stringify({ title: `${title} parent` }) },
      admin
    );
    const parent = z
      .object({ id: z.string(), status: z.string() })
      .parse(await parentRes.json());
    const childRes = await fetch(
      `/workspaces/${org}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          parentId: parent.id,
          stepKey: `step_${crypto.randomUUID().slice(0, 6)}`,
          required: true,
          ownerAgent: "scout",
        }),
      },
      admin
    );
    const child = z.object({ id: z.string() }).parse(await childRes.json());
    return { parent, child };
  }

  async function runTerminalSubStepLane(
    issueId: string,
    status: "completed" | "failed",
    conversationKey: string
  ) {
    const stub = getWorkspaceStub(env, org);
    const session = await stub.createAgentSession({
      issueId,
      agentId: "mock-scout",
      provider: "mock-scout",
      actorId: "test",
      actorType: "agent",
      status: "running",
      conversationKey,
    });
    await stub.applyAgentSessionResult(session.id, {
      status,
      result: status === "completed" ? "work output" : "lane exploded",
    });
    return session;
  }

  it("POSTs substep.ready_for_review to the external chief_of_staff once, with a delivery record on the issue (PILE-443)", async () => {
    const endpoint = "https://chief.example.test/hook";
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "chief_of_staff",
          name: "Chief of Staff",
          providerAgentId: "flue",
          kind: "external",
          endpointUrl: endpoint,
          endpointSecret: "test-endpoint-secret",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);

    const { parent, child } = await createRequiredSubStep("Chief gated step");
    const session = await runTerminalSubStepLane(
      child.id,
      "completed",
      `${parent.id}-scout`
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const stub = getWorkspaceStub(env, org);
      await drainDomainEvents(env, stub, org);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-endpoint-secret");
    const payload = z
      .object({
        event: z.literal("substep.ready_for_review"),
        issueId: z.string(),
        parentId: z.string(),
        issue: z.object({ id: z.string() }),
        session: z.object({
          id: z.string(),
          status: z.string(),
          conversationKey: z.string(),
        }),
        conversationKey: z.string(),
      })
      .parse(JSON.parse(init.body as string));
    expect(payload.issueId).toBe(child.id);
    expect(payload.issue.id).toBe(child.id);
    expect(payload.parentId).toBe(parent.id);
    expect(payload.session.id).toBe(session.id);
    expect(payload.session.status).toBe("completed");
    expect(payload.session.conversationKey).toBe(`${parent.id}-scout`);

    // PILE-441 — the dispatch attempt lands on the issue as an internal
    // delivery record.
    const stub = getWorkspaceStub(env, org);
    const comments = await stub.listComments(child.id);
    const delivery = comments.find(
      (comment) =>
        comment.externalSource === "pipeline-runtime" &&
        comment.body.includes("substep.ready_for_review") &&
        comment.body.includes("delivered")
    );
    expect(delivery).toBeDefined();
    expect(delivery?.internal).toBe(true);
  });

  it("POSTs agent.session_failed to the stage-owner reviewer when a gated lane dies (PILE-443)", async () => {
    const reviewerEndpoint = "https://reviewer.example.test/hook";
    const chiefEndpoint = "https://chief2.example.test/hook";
    for (const [slug, endpointUrl] of [
      ["stage_reviewer", reviewerEndpoint],
      ["chief_of_staff", chiefEndpoint],
    ] as const) {
      const type = await fetch(
        `/workspaces/${org}/agent-types`,
        {
          method: "POST",
          body: JSON.stringify({
            slug,
            name: slug,
            providerAgentId: "flue",
            kind: "external",
            endpointUrl,
            endpointSecret: null,
          }),
        },
        admin
      );
      expect(type.status).toBe(200);
    }

    const { parent, child } = await createRequiredSubStep("Failed gated step");
    // The stage owner reviews first — point the parent's stage at the
    // external reviewer so the failure POST goes to it, not the chief.
    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          status: parent.status,
          ownerAgent: "stage_reviewer",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);

    await runTerminalSubStepLane(child.id, "failed", `${parent.id}-scout`);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const stub = getWorkspaceStub(env, org);
      await drainDomainEvents(env, stub, org);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(reviewerEndpoint);
    const payload = JSON.parse(init.body as string) as {
      event: string;
      issueId: string;
      session: { status: string } | null;
    };
    expect(payload.event).toBe("agent.session_failed");
    expect(payload.issueId).toBe(child.id);
    expect(payload.session?.status).toBe("failed");
  });

  it("POSTs substep.orphaned to the external chief_of_staff instead of dispatching a lane (PILE-440)", async () => {
    const endpoint = "https://chief.example.test/orphan";
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "chief_of_staff",
          name: "Chief of Staff",
          providerAgentId: "flue",
          kind: "external",
          endpointUrl: endpoint,
          endpointSecret: "orphan-secret",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);

    // A sub-step whose ownerAgent resolves to nothing is the orphan —
    // moving it to an actionable status fires substep.actionable.
    const parentRes = await fetch(
      `/workspaces/${org}/issues`,
      { method: "POST", body: JSON.stringify({ title: "orphan parent" }) },
      admin
    );
    const parent = z
      .object({ id: z.string() })
      .parse(await parentRes.json());
    const childRes = await fetch(
      `/workspaces/${org}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "orphaned step",
          parentId: parent.id,
          stepKey: `step_${crypto.randomUUID().slice(0, 6)}`,
          required: true,
          ownerAgent: `ghost-${crypto.randomUUID().slice(0, 6)}`,
        }),
      },
      admin
    );
    const child = z.object({ id: z.string() }).parse(await childRes.json());
    const moved = await fetch(
      `/workspaces/${org}/issues/${child.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "todo" }) },
      admin
    );
    expect(moved.status).toBe(200);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const stub = getWorkspaceStub(env, org);
      await drainDomainEvents(env, stub, org);
    } finally {
      vi.unstubAllGlobals();
    }

    const orphanCall = fetchMock.mock.calls.find(
      ([u]) => u === endpoint
    ) as unknown as [string, RequestInit] | undefined;
    expect(orphanCall).toBeDefined();
    const headers = orphanCall![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer orphan-secret");
    const payload = z
      .object({
        event: z.literal("substep.orphaned"),
        issueId: z.string(),
        parentId: z.string(),
        agent: z.literal("chief_of_staff"),
      })
      .parse(JSON.parse(orphanCall![1].body as string));
    expect(payload.issueId).toBe(child.id);
    expect(payload.parentId).toBe(parent.id);

    // No lane was launched for the external owner.
    const stub = getWorkspaceStub(env, org);
    const sessions = await stub.listAgentSessions({ issueId: child.id });
    expect(sessions).toHaveLength(0);

    // The dispatch attempt lands as an internal delivery record.
    const comments = await stub.listComments(child.id);
    const delivery = comments.find(
      (comment) =>
        comment.externalSource === "pipeline-runtime" &&
        comment.body.includes("substep.orphaned") &&
        comment.body.includes("delivered")
    );
    expect(delivery).toBeDefined();
    expect(delivery?.internal).toBe(true);
  });
});

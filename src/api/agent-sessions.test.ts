import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentLogToken } from "../agents/credentials.js";
import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import {
  githubInstallations,
  organization,
  user as userTable,
} from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://your-domain.com";

function request(
  path: string,
  init: RequestInit & { token?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method ?? "GET")) {
    headers.set("Origin", ORIGIN);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

function registerPlanMock() {
  const agentId = `mock-plan-${crypto.randomUUID().slice(0, 8)}`;
  const seen: Array<{
    instructions?: string;
    extraEnv?: Record<string, string>;
  }> = [];
  registerAgentProvider(
    agentId,
    () =>
      new MockAgentProvider(agentId, {
        dispatch: (_org, dispatchedIssue, _model, ctx) => {
          seen.push({
            instructions: ctx?.instructions,
            extraEnv: ctx?.extraEnv,
          });
          return {
            id: `plan-${crypto.randomUUID()}`,
            agentId,
            issueId: dispatchedIssue.id,
            status: "created" as const,
          };
        },
      })
  );
  return { agentId, seen };
}

describe("agent sessions API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-1",
        name: "Test User",
        email: "user-1@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Agent API tests",
      slug: `agent-api-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    organizationId = workspace!.id;
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({
          key: workspace?.key ?? null,
          maxConcurrentAgentChildren: 2,
        }),
      })
      .where(eq(organization.id, organizationId));
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;

    registerAgentProvider("mock", () => new MockAgentProvider("mock"));
  });

  it("creates a session by dispatching an agent", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Agent test",
          repo: "VortexNYC/pile",
        }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      id: string;
      issueId: string;
      status: string;
    }>();
    expect(session.issueId).toBe(issue.id);
    expect(session.status).toBe("created");

    const listRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=${issue.id}`,
        {
          token,
        }
      ),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ sessions: unknown[] }>();
    expect(list.sessions.length).toBe(1);

    // PILE-418 — a fresh dispatch sits inside the ~10s first-ack window:
    // firstActivityAt is unset and the lane is not flagged.
    expect(
      (session as { firstActivityAt?: string | null }).firstActivityAt ?? null
    ).toBeNull();
    expect(
      (session as { awaitingFirstAck?: boolean }).awaitingFirstAck ?? false
    ).toBe(false);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ activities: unknown[] }>();
    expect(got.activities.length).toBeGreaterThanOrEqual(1);

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json<{ events: unknown[] }>();
    expect(eventsBody.events.length).toBeGreaterThanOrEqual(1);

    const missingRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/00000000-0000-0000-0000-000000000000/events`,
        { token }
      ),
      env
    );
    expect(missingRes.status).toBe(404);
  });

  it("validates lane output against a dispatch result schema and labels the run", async () => {
    let seenInstructions: string | undefined;
    registerAgentProvider(
      "mock-structured",
      () =>
        new MockAgentProvider("mock-structured", {
          dispatch: async (_org, issue, _model, ctx) => {
            seenInstructions = ctx?.instructions;
            return {
              id: `structured-${issue.id}`,
              agentId: "mock-structured",
              issueId: issue.id,
              status: "running",
            };
          },
        })
    );

    const createIssue = async (title: string) => {
      const res = await app.fetch(
        request(`/workspaces/${organizationId}/issues`, {
          method: "POST",
          token,
          body: JSON.stringify({ title }),
        }),
        env
      );
      expect(res.status).toBe(201);
      return res.json<{ id: string; identifier: string }>();
    };
    const dispatch = (issueId: string, body: Record<string, unknown>) =>
      app.fetch(
        request(`/workspaces/${organizationId}/issues/${issueId}/dispatch`, {
          method: "POST",
          token,
          body: JSON.stringify({ agentId: "mock-structured", ...body }),
        }),
        env
      );
    const patch = (sessionId: string, result: string) =>
      app.fetch(
        request(`/workspaces/${organizationId}/agent/sessions/${sessionId}`, {
          method: "PATCH",
          token,
          body: JSON.stringify({ status: "completed", result }),
        }),
        env
      );
    type StructuredSession = {
      id: string;
      label: string | null;
      resultSchema: Record<string, unknown> | null;
      structuredResult: unknown;
      resultSchemaErrors: string[] | null;
    };

    const ok = await createIssue("Structured result happy path");
    const okRes = await dispatch(ok.id, { resultSchema: "lane" });
    expect(okRes.status).toBe(201);
    const okSession = await okRes.json<StructuredSession>();
    expect(okSession.label).toBe(
      `mock-structured/${ok.identifier.toLowerCase()}-structured-result-happy-path`
    );
    expect(okSession.resultSchema?.required).toEqual([
      "verdict",
      "summary",
      "filesChanged",
    ]);
    expect(okSession.structuredResult).toBeNull();
    expect(seenInstructions).toContain("## Structured result");

    const value = {
      verdict: "pass",
      summary: "Implemented",
      filesChanged: ["src/a.ts"],
    };
    const okPatch = await patch(
      okSession.id,
      `All done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
    );
    expect(okPatch.status).toBe(200);
    const okDone = await okPatch.json<StructuredSession>();
    expect(okDone.structuredResult).toEqual(value);
    expect(okDone.resultSchemaErrors).toBeNull();

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${okSession.id}/events`,
        { token }
      ),
      env
    );
    const { events } = await eventsRes.json<{
      events: { type: string; payload: Record<string, unknown> | null }[];
    }>();
    expect(
      events.find((e) => e.type === "session.structured_result")?.payload
    ).toEqual({ valid: true, value });
    expect(
      events.find((e) => e.type === "session.summary")?.payload
    ).toMatchObject({ structuredResult: value, label: okSession.label });

    const bad = await createIssue("Structured result mismatch");
    const badRes = await dispatch(bad.id, {
      resultSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    });
    expect(badRes.status).toBe(201);
    const badSession = await badRes.json<StructuredSession>();
    const badPatch = await patch(badSession.id, JSON.stringify({ ok: "yes" }));
    const badDone = await badPatch.json<StructuredSession>();
    expect(badDone.structuredResult).toBeNull();
    expect(badDone.resultSchemaErrors?.[0]).toMatch(/^ok: /);

    const invalid = await createIssue("Structured result invalid schema");
    const invalidRes = await dispatch(invalid.id, {
      resultSchema: { type: "bogus" },
    });
    expect(invalidRes.status).toBe(400);
  });

  it("serves light summary rows with ?summary=1 while the default list keeps blobs", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Summary list target" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    // Terminal statuses only — live lanes count against the workspace's
    // dispatch ceiling and would break later dispatch tests.
    const blob = "result-blob ".repeat(400);
    for (let i = 0; i < 100; i++) {
      await stub.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: i % 2 === 0 ? "completed" : "failed",
        result: `${i} ${blob}`,
        prUrl:
          i % 2 === 0
            ? `https://github.com/VortexNYC/pile/pull/${i + 1}`
            : null,
        prState: i % 2 === 0 ? "open" : null,
        startedAt: new Date().toISOString(),
      });
    }

    const fullRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=${issue.id}&limit=100`,
        { token }
      ),
      env
    );
    expect(fullRes.status).toBe(200);
    const fullText = await fullRes.text();
    const full = JSON.parse(fullText) as {
      sessions: Record<string, unknown>[];
    };
    expect(full.sessions).toHaveLength(100);
    expect(full.sessions[0]).toHaveProperty("result");
    // sanity: with result blobs the full list is heavy — what `summary=1`
    // exists to avoid.
    expect(fullText.length).toBeGreaterThan(20 * 1024);

    const summaryRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=${issue.id}&limit=100&summary=1`,
        { token }
      ),
      env
    );
    expect(summaryRes.status).toBe(200);
    const summaryText = await summaryRes.text();
    const { sessions } = JSON.parse(summaryText) as {
      sessions: Record<string, unknown>[];
    };
    expect(sessions).toHaveLength(100);
    for (const s of sessions) {
      expect(s.issueId).toBe(issue.id);
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("agentId");
      expect(s).toHaveProperty("status");
      expect(s).toHaveProperty("prUrl");
      expect(s).toHaveProperty("createdAt");
      expect(s).toHaveProperty("updatedAt");
      expect(s).toHaveProperty("derivedStatus");
      expect(s).not.toHaveProperty("result");
      expect(s).not.toHaveProperty("activities");
      expect(s).not.toHaveProperty("organizationId");
      expect(s).not.toHaveProperty("actorId");
      expect(s).not.toHaveProperty("providerSessionId");
      expect(s).not.toHaveProperty("lastStateHash");
      expect(s).not.toHaveProperty("laneDbRef");
    }
    expect(summaryText.length).toBeLessThan(48 * 1024);
    expect(summaryText.length * 8).toBeLessThan(fullText.length);
  });

  it("serves a summary detail with ?summary=1", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-summary-detail",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      result: "blob ".repeat(200),
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}?summary=1`,
        { token }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.id).toBe(session.id);
    expect(body.status).toBe("created");
    expect(body).not.toHaveProperty("result");
    expect(body).not.toHaveProperty("activities");
    expect(body).not.toHaveProperty("actorId");

    const missing = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/00000000-0000-0000-0000-000000000000?summary=1`,
        { token }
      ),
      env
    );
    expect(missing.status).toBe(404);
  });

  it("dispatches an agent on a repo-less issue (research/docs/design work)", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Write onboarding doc" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string; repo: unknown }>();
    expect(issue.repo).toBeNull();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{ status: string }>();
    expect(session.status).toBe("created");
  });

  it("falls back to the repo's default agent when none is given", async () => {
    const db = createD1(env.D1);
    const agentId = `mock-repo-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));
    const repo = "VortexNYC/other-repo";
    await db.insert(githubInstallations).values({
      id: crypto.randomUUID(),
      organizationId,
      installationId: "inst-1",
      repo,
      defaultAgentId: agentId,
    });

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Repo default", repo }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{ agentId: string }>();
    expect(session.agentId).toBe(agentId);
  });

  it("returns a preflight report and flags gaps on the thread once", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Fix the thing",
          description: "TBD.",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      id: string;
      preflight?: { ready: boolean; missing: string[] };
    }>();
    expect(session.preflight?.ready).toBe(false);
    expect(session.preflight?.missing.length).toBeGreaterThan(0);

    const commentsRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/comments`, {
        token,
      }),
      env
    );
    const comments = await commentsRes.json<{
      comments: Array<{ externalSource: string | null; body: string }>;
    }>();
    const flagged = (comments.comments ?? comments).filter(
      (c: { externalSource: string | null }) => c.externalSource === "preflight"
    );
    expect(flagged.length).toBe(1);
  });

  it("preflight dispatch creates a repo-less critique session", async () => {
    const agentId = `mock-pf-${crypto.randomUUID().slice(0, 8)}`;
    let seenRepo: string | null | undefined;
    let seenInstructions: string | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue, _model, ctx) => {
            seenRepo = dispatchedIssue.repo;
            seenInstructions = ctx?.instructions;
            return {
              id: `pf-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Improve the sweep",
          description:
            "Lanes should rebase when the base branch moves forward so their PRs never land stale. Verify the sweep detects out-of-date PRs and prompts the lane.",
          repo: "VortexNYC/pile",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId, preflight: true }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      purpose?: string | null;
      preflight?: { ready: boolean };
    }>();
    expect(session.purpose).toBe("preflight");
    expect(session.preflight?.ready).toBe(true);
    expect(seenRepo).toBeNull();
    expect(seenInstructions).toContain("do NOT implement");
    expect(seenInstructions).toContain("VortexNYC/pile");
  });

  function workspaceStub() {
    return env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
  }

  async function createPlanIssue(title: string) {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title }),
      }),
      env
    );
    expect(res.status).toBe(201);
    return res.json<{ id: string }>();
  }

  async function dispatchPlan(issueId: string, body: Record<string, unknown>) {
    return app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify(body),
      }),
      env
    );
  }

  async function comment(issueId: string, body: string) {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issueId}/comments`, {
        method: "POST",
        token,
        body: JSON.stringify({ body }),
      }),
      env
    );
    expect(res.status).toBe(201);
  }

  async function completeWithPlan(sessionId: string, plan: string) {
    await workspaceStub().applyAgentSessionResult(sessionId, {
      status: "completed",
      result: JSON.stringify({ output_tail: plan }),
    });
  }

  describe("plan mode (PILE-283)", () => {
    it("plan → revise → implement_plan dispatches a build lane from the plan", async () => {
      const { agentId, seen } = registerPlanMock();
      const issue = await createPlanIssue(
        `Plan-mode flow ${crypto.randomUUID().slice(0, 8)}`
      );

      const planRes = await dispatchPlan(issue.id, { agentId, mode: "plan" });
      expect(planRes.status).toBe(201);
      const planSession = await planRes.json<{
        id: string;
        purpose?: string | null;
      }>();
      expect(planSession.purpose).toBe("plan");
      expect(seen[0]?.instructions).toContain("PLAN MODE");
      expect(seen[0]?.extraEnv?.PILE_LANE_MODE).toBe("plan");

      await completeWithPlan(planSession.id, "1. Approach: add a flag");
      const stub = workspaceStub();
      const planComments = (await stub.listComments(issue.id)).filter(
        (c) => c.externalSource === "plan"
      );
      expect(planComments).toHaveLength(1);
      expect(planComments[0]?.externalId).toBe(planSession.id);
      expect(planComments[0]?.body).toContain("1. Approach: add a flag");

      // PlanEdit: `/plan <feedback>` revises the latest plan.
      await comment(issue.id, "/plan use a config key instead of a flag");
      expect(seen).toHaveLength(2);
      expect(seen[1]?.instructions).toContain(
        "Previous plan:\n1. Approach: add a flag"
      );
      expect(seen[1]?.instructions).toContain(
        "use a config key instead of a flag"
      );
      expect(seen[1]?.extraEnv?.PILE_LANE_MODE).toBe("plan");
      const revision = (await stub.getActiveAgentSessionForIssue(issue.id))
        ?.session;
      expect(revision?.purpose).toBe("plan");
      if (!revision) throw new Error("revision lane missing");
      await completeWithPlan(revision.id, "1. Approach: add a config key");

      const buildRes = await dispatchPlan(issue.id, {
        agentId,
        mode: "implement_plan",
      });
      expect(buildRes.status).toBe(201);
      const buildSession = await buildRes.json<{
        id: string;
        purpose?: string | null;
      }>();
      expect(buildSession.purpose ?? null).toBeNull();
      expect(seen[2]?.instructions).toContain("APPROVED implementation plan");
      expect(seen[2]?.instructions).toContain("1. Approach: add a config key");
      expect(seen[2]?.instructions).not.toContain("add a flag");
      expect(seen[2]?.extraEnv?.PILE_LANE_MODE).toBeUndefined();

      const events = await stub.listAgentSessionEvents(buildSession.id);
      expect(events.some((e) => e.type === "lane.plan")).toBe(true);
    });

    it("implement_plan without a plan is rejected", async () => {
      const { agentId } = registerPlanMock();
      const issue = await createPlanIssue(
        `Planless ${crypto.randomUUID().slice(0, 8)}`
      );
      const res = await dispatchPlan(issue.id, {
        agentId,
        mode: "implement_plan",
      });
      expect(res.status).toBe(400);
    });

    it("adding the plan label dispatches a plan lane", async () => {
      const { agentId, seen } = registerPlanMock();
      const issue = await createPlanIssue(
        `Plan label ${crypto.randomUUID().slice(0, 8)}`
      );
      // An earlier lane pins the agent the label trigger reuses.
      const firstRes = await dispatchPlan(issue.id, { agentId });
      expect(firstRes.status).toBe(201);
      const first = await firstRes.json<{ id: string }>();
      await workspaceStub().applyAgentSessionResult(first.id, {
        status: "completed",
        result: "done",
      });
      const labelRes = await app.fetch(
        request(`/workspaces/${organizationId}/labels`, {
          method: "POST",
          token,
          body: JSON.stringify({ name: "Plan" }),
        }),
        env
      );
      expect(labelRes.status).toBe(201);
      const label = await labelRes.json<{ id: string }>();

      const patchRes = await app.fetch(
        request(`/workspaces/${organizationId}/issues/${issue.id}`, {
          method: "PATCH",
          token,
          body: JSON.stringify({ labelIds: [label.id] }),
        }),
        env
      );
      expect(patchRes.status).toBe(200);
      const lane = (
        await workspaceStub().getActiveAgentSessionForIssue(issue.id)
      )?.session;
      expect(lane?.purpose).toBe("plan");
      expect(seen.at(-1)?.extraEnv?.PILE_LANE_MODE).toBe("plan");
    });
  });

  it("sets a repo's default agent via installation PATCH", async () => {
    const db = createD1(env.D1);
    const instId = crypto.randomUUID();
    const repo = "VortexNYC/patch-repo";
    await db.insert(githubInstallations).values({
      id: instId,
      organizationId,
      installationId: "inst-2",
      repo,
    });

    const patchRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations/${instId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ defaultAgentId: "devin" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json<{ defaultAgentId: string }>();
    expect(updated.defaultAgentId).toBe("devin");

    const badRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations/${instId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ defaultAgentId: "not-a-provider" }),
      }),
      env
    );
    expect(badRes.status).toBe(400);
  });

  it("dispatches via the provider alias and rejects unknown body keys", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Alias", repo: "VortexNYC/pile" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const aliasRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ provider: "mock" }),
      }),
      env
    );
    expect(aliasRes.status).toBe(201);
    const session = await aliasRes.json<{ agentId: string }>();
    expect(session.agentId).toBe("mock");

    const badRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ provdier: "mock" }),
      }),
      env
    );
    expect(badRes.status).toBe(400);
  });

  it("accepts repo/branch/instructions overrides without mutating the issue", async () => {
    let captured:
      | {
          issue: { repo?: string | null; branch?: string | null };
          context?: { instructions?: string };
        }
      | undefined;
    registerAgentProvider(
      "mock-override",
      () =>
        new MockAgentProvider("mock-override", {
          dispatch: (_org, dispatchedIssue, _model, ctx) => {
            captured = { issue: dispatchedIssue, context: ctx };
            return {
              id: "override-1",
              agentId: "mock-override",
              status: "created",
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Override dispatch" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({
          agentId: "mock-override",
          repo: "VortexNYC/other",
          branch: "feat/override",
          instructions: "Stay inside src/api",
        }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    expect(captured?.issue.repo).toBe("VortexNYC/other");
    expect(captured?.issue.branch).toBe("feat/override");
    expect(captured?.context?.instructions).toBe("Stay inside src/api");

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}`, { token }),
      env
    );
    const stored = await getRes.json<{
      repo: string | null;
      branch: string | null;
    }>();
    expect(stored.repo).toBeNull();
    expect(stored.branch).toBeNull();
  });

  it("prefers stored repo/branch when no overrides are given", async () => {
    let captured: { repo?: string | null; branch?: string | null } | undefined;
    registerAgentProvider(
      "mock-stored",
      () =>
        new MockAgentProvider("mock-stored", {
          dispatch: (_org, dispatchedIssue) => {
            captured = dispatchedIssue;
            return {
              id: "stored-1",
              agentId: "mock-stored",
              status: "created",
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Stored repo",
          repo: "VortexNYC/pile",
          branch: "iss-42",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock-stored" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    expect(captured?.repo).toBe("VortexNYC/pile");
    expect(captured?.branch).toBe("iss-42");
  });

  it("retries a completed session into a new session on the same lane branch", async () => {
    const agentId = `mock-retry-${crypto.randomUUID().slice(0, 8)}`;
    let seenBranch: string | null | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            seenBranch = dispatchedIssue.branch;
            return {
              id: `rs-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Retry lane",
          repo: "acme/roadmap",
          branch: "lane/pile-249",
        }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "completed",
      result: "opened a PR",
    });

    const retryRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/retry`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ context: "address the review feedback" }),
        }
      ),
      env
    );
    expect(retryRes.status).toBe(201);
    const retried = await retryRes.json<{
      id: string;
      issueId: string;
      status: string;
    }>();
    expect(retried.id).not.toBe(session.id);
    expect(retried.issueId).toBe(issue.id);
    // The lane branch is already on the issue — the new session resumes it.
    expect(seenBranch).toBe("lane/pile-249");
    const stored = await stub.getAgentSession(retried.id);
    expect(stored?.retryOf).toBe(session.id);
    expect(stored?.retryCount).toBe(1);
  });

  it("re-queues a retry behind the session's queuedAfter blocker and re-anchors dependents", async () => {
    const agentId = `mock-requeue-${crypto.randomUUID().slice(0, 8)}`;
    let dispatches = 0;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            dispatches += 1;
            return {
              id: `rq-${dispatches}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const blockerIssue = await stub.createIssue({
      title: "Retry chain blocker",
    });
    const blocker = await stub.createAgentSession({
      issueId: blockerIssue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });
    const laneIssue = await stub.createIssue({ title: "Retry chain lane" });
    // A promoted-then-failed lane still carries its queuedAfter edge.
    const lane = await stub.createAgentSession({
      issueId: laneIssue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "failed",
      result: "sandbox died",
      queuedAfter: blocker.id,
    });
    const depIssue = await stub.createIssue({ title: "Retry chain dependent" });
    const dependent = await stub.createAgentSession({
      issueId: depIssue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "waiting",
      queuedAfter: lane.id,
    });

    const retryRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${lane.id}/retry`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }),
      env
    );
    expect(retryRes.status).toBe(201);
    const retried = await retryRes.json<{ id: string; status: string }>();
    // The retry re-enters the queue behind the original blocker instead of
    // dispatching in parallel with the chain (PILE-260).
    expect(retried.status).toBe("waiting");
    expect(dispatches).toBe(0);
    const storedRetry = await stub.getAgentSession(retried.id);
    expect(storedRetry?.queuedAfter).toBe(blocker.id);
    expect(storedRetry?.retryOf).toBe(lane.id);
    expect(storedRetry?.retryCount).toBe(1);
    // The lane parked behind the dead one re-anchors on its replacement so
    // it can't promote off the corpse.
    const dependentAfter = await stub.getAgentSession(dependent.id);
    expect(dependentAfter?.queuedAfter).toBe(retried.id);

    // Release the lanes this test parked — the suite shares one workspace
    // and non-terminal sessions count against the live-lane cap.
    for (const id of [blocker.id, retried.id, dependent.id]) {
      await stub.updateAgentSession(id, { status: "canceled" });
    }
  });

  it("appends an activity and updates session state", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-patch",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ type: "thought", message: "Hello" }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(201);

    const patchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "completed", result: "done" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<{
      status: string;
      result: string | null;
    }>();
    expect(patched.status).toBe("completed");
    expect(patched.result).toBe("done");
  });

  it("records span activities with parent links and close-out duration", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-span",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const spanRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "action",
            message: "provision sandbox",
            startedAt: new Date(Date.now() - 1500).toISOString(),
          }),
        }
      ),
      env
    );
    expect(spanRes.status).toBe(201);
    const span = await spanRes.json<{
      id: string;
      startedAt: string | null;
      endedAt: string | null;
    }>();
    expect(span.startedAt).toBeTruthy();
    expect(span.endedAt).toBeNull();

    const childRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "status",
            message: "sandbox created",
            parentId: span.id,
          }),
        }
      ),
      env
    );
    expect(childRes.status).toBe(201);
    const child = await childRes.json<{ parentId: string | null }>();
    expect(child.parentId).toBe(span.id);

    const closed = await stub.closeAgentActivity(span.id);
    expect(closed?.endedAt).toBeTruthy();
    expect(closed?.durationMs).toBeGreaterThanOrEqual(0);

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    const events = await eventsRes.json<{
      events: {
        id: string;
        parentId: string | null;
        durationMs: number | null;
      }[];
    }>();
    const spanEvent = events.events.find((e) => e.id === span.id);
    expect(spanEvent?.durationMs).toBeGreaterThanOrEqual(0);
    const childEvent = events.events.find((e) => e.parentId === span.id);
    expect(childEvent).toBeTruthy();
  });

  it("suspends a session on elicitation and resumes it on respond (PILE-419)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "Elicitation lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    // The lane asks a human: activity lands, the session parks in `waiting`
    // with the open question recorded (no runtime held), and needs_input
    // surfaces on the derived status.
    const elicitationRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "elicitation",
            message: "Ship to staging or prod?",
          }),
        }
      ),
      env
    );
    expect(elicitationRes.status).toBe(201);
    const elicitation = await elicitationRes.json<{
      id: string;
      type: string;
      startedAt: string | null;
    }>();
    expect(elicitation.startedAt).toBeTruthy();

    const parked = await stub.getAgentSession(session.id);
    expect(parked?.status).toBe("waiting");
    expect(parked?.awaitingActivityId).toBe(elicitation.id);

    const needsInput = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    const needsInputBody = await needsInput.json<{
      status: string;
      awaitingActivityId: string | null;
      derivedStatus: string | null;
    }>();
    expect(needsInputBody.derivedStatus).toBe("needs_input");
    expect(needsInputBody.awaitingActivityId).toBe(elicitation.id);

    // The human's answer records a `response` activity parented to the
    // question, closes the question's span, and resumes the session.
    const respondRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ answer: "staging first" }),
        }
      ),
      env
    );
    expect(respondRes.status).toBe(200);
    const resumed = await respondRes.json<{
      status: string;
      awaitingActivityId: string | null;
      derivedStatus: string | null;
      activities: { id: string; type: string; parentId: string | null }[];
    }>();
    expect(resumed.status).toBe("running");
    expect(resumed.awaitingActivityId).toBeNull();
    const answer = resumed.activities.find((a) => a.type === "response");
    expect(answer).toBeTruthy();
    expect(answer?.parentId).toBe(elicitation.id);
    const answered = resumed.activities.find((a) => a.id === elicitation.id);
    expect(answered).toBeTruthy();

    // The elicitation span closed — durationMs is the answer latency — and
    // the answer announcement lands on the event stream.
    const closed = await stub.getAgentActivity(elicitation.id);
    expect(closed?.endedAt).toBeTruthy();
    expect(closed?.durationMs).toBeGreaterThanOrEqual(0);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    const responseEvent = events.find((e) => e.type === "elicitation.response");
    expect(responseEvent).toBeTruthy();
    expect(
      (JSON.parse(responseEvent?.payload ?? "{}") as { elicitationId?: string })
        .elicitationId
    ).toBe(elicitation.id);

    // A second answer has no open question — 409, not a stray response.
    const againRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ answer: "actually prod" }),
        }
      ),
      env
    );
    expect(againRes.status).toBe(409);

    // Release the active-session slot — the workspace caps live lanes.
    await stub.applyAgentSessionResult(session.id, { status: "canceled" });
  });

  it("409s respond when the session has no open elicitation", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "No elicitation lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });
    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ answer: "no question pending" }),
        }
      ),
      env
    );
    expect(res.status).toBe(409);
    await stub.applyAgentSessionResult(session.id, { status: "canceled" });
  });

  it("delivers a provider-managed answer into the live sandbox via sendPrompt", async () => {
    const agentId = `mock-respond-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          sendPrompt: (_id, prompt) => {
            prompts.push(prompt);
            return true;
          },
        })
    );
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "Provider answer lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-1",
    });
    await stub.addAgentActivity({
      sessionId: session.id,
      type: "elicitation",
      message: "Which region?",
    });
    expect((await stub.getAgentSession(session.id))?.status).toBe("waiting");

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ answer: "us-east" }),
        }
      ),
      env
    );
    expect(res.status).toBe(200);
    expect(prompts).toEqual(["us-east"]);
    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("running");
    expect(after?.awaitingActivityId).toBeNull();
    await stub.applyAgentSessionResult(session.id, { status: "canceled" });
  });

  it("409s respond when the provider sandbox is gone, keeping the question open", async () => {
    const agentId = `mock-dead-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          sendPrompt: () => false,
        })
    );
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "Dead sandbox lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-dead",
    });
    const elicitation = await stub.addAgentActivity({
      sessionId: session.id,
      type: "elicitation",
      message: "Ready to proceed?",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/respond`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ answer: "yes" }),
        }
      ),
      env
    );
    expect(res.status).toBe(409);
    // Undelivered answers don't close the question.
    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("waiting");
    expect(after?.awaitingActivityId).toBe(elicitation.id);
    await stub.applyAgentSessionResult(session.id, { status: "canceled" });
  });

  it("records `prompt` activities for human follow-ups (PILE-419)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({ title: "Prompt activity" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    // `prompt` is a valid activity type on the raw route (Linear's model —
    // the human's message to the agent).
    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "prompt",
            message: "please also update the docs",
          }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(201);
    const activity = await activityRes.json<{ type: string }>();
    expect(activity.type).toBe("prompt");

    // The /prompt route records the same type — the ask is auditable.
    const promptRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/prompt`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ prompt: "check the flake" }),
        }
      ),
      env
    );
    expect(promptRes.status).toBe(200);
    const activities = await stub.listAgentActivities(session.id);
    expect(
      activities.some((a) => a.type === "prompt" && a.actorId === "user-1")
    ).toBe(true);
    await stub.applyAgentSessionResult(session.id, { status: "canceled" });
  });

  it("captures a text artifact to the session timeline", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-text",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            name: "diff.patch",
            type: "diff",
            content: "@@ -1 +1 @@\n- old\n+ new",
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);

    const activity = await res.json<{
      type: string;
      message: string;
      payload: {
        name: string;
        type: string;
        content: string;
        provider: string;
      };
    }>();
    expect(activity.type).toBe("artifact");
    expect(activity.message).toBe("Artifact: diff.patch");
    expect(activity.payload.type).toBe("diff");
    expect(activity.payload.content).toContain("+ new");
    expect(activity.payload.provider).toBe("mock");

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json<{
      events: Array<{ type: string; payload: { type: string } }>;
    }>();
    expect(
      eventsBody.events.some(
        (event) =>
          event.type === "artifact" || event.payload.type === "artifact"
      )
    ).toBe(true);
  });

  it("captures a binary artifact to R2", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-binary",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            name: "screenshot.png",
            type: "screenshot",
            data: btoa("binary content"),
            mimeType: "image/png",
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);

    const activity = await res.json<{
      payload: { r2Key: string; attachmentId: string };
    }>();
    expect(activity.payload.r2Key).toBeTruthy();
    expect(activity.payload.attachmentId).toBeTruthy();

    const stored = await env.ATTACHMENTS_BUCKET.get(activity.payload.r2Key);
    expect(stored).not.toBeNull();
  });

  it("rejects an artifact with no content, data, or url", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-empty",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ name: "empty", type: "other" }),
        }
      ),
      env
    );
    expect(res.status).toBe(400);
  });

  it("shows live agent state for an issue", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-live",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });
    await stub.addAgentActivity({
      sessionId: session.id,
      actorId: "user-1",
      type: "status",
      message: "Running tests",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/issues/issue-live/live`, {
        token,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      session: { id: string; status: string } | null;
      activities: Array<{ type: string; message: string }>;
    }>();
    expect(body.session?.id).toBe(session.id);
    expect(body.session?.status).toBe("running");
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]?.type).toBe("status");
  });

  it("returns live provider state for sessions that support it", async () => {
    registerAgentProvider(
      "mock-state",
      () =>
        new MockAgentProvider("mock-state", {
          getState: (_providerSessionId, trackerSessionId) => ({
            provider: { status: "running" },
            compute: { sandbox: trackerSessionId },
          }),
        })
    );

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-state",
      agentId: "mock-state",
      provider: "mock-state",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/state`,
        { token }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { id: string; status: string };
      provider: { status: string };
      compute: { sandbox: string };
    };
    expect(body.session.id).toBe(session.id);
    expect(body.provider.status).toBe("running");
    expect(body.compute.sandbox).toBe(session.id);
  });

  it("returns 400 for live state when the agent does not support it", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-no-state",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/state`,
        { token }
      ),
      env
    );
    expect(res.status).toBe(400);
  });

  it("uses scoped agent:read and agent:write permissions", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-scoped",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const tokenRes = await app.fetch(
      request(`/workspaces/${organizationId}/tokens`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "scoped-agent",
          permissions: "agent:read,agent:write",
          actorType: "agent",
        }),
      }),
      env
    );
    expect(tokenRes.status).toBe(201);
    const { token: agentToken } = await tokenRes.json<{ token: string }>();

    const listRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=issue-scoped`,
        { token: agentToken }
      ),
      env
    );
    expect(listRes.status).toBe(200);

    // PILE-418 — a fresh dispatch sits inside the ~10s first-ack window:
    // firstActivityAt is unset and the lane is not flagged.
    expect(
      (session as { firstActivityAt?: string | null }).firstActivityAt ?? null
    ).toBeNull();
    expect(
      (session as { awaitingFirstAck?: boolean }).awaitingFirstAck ?? false
    ).toBe(false);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token: agentToken,
      }),
      env
    );
    expect(getRes.status).toBe(200);

    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token: agentToken,
          body: JSON.stringify({ type: "thought", message: "scoped" }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(201);

    const patchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token: agentToken,
        body: JSON.stringify({ status: "completed" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);

    const readOnlyRes = await app.fetch(
      request(`/workspaces/${organizationId}/tokens`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "readonly-agent",
          permissions: "agent:read",
          actorType: "agent",
        }),
      }),
      env
    );
    expect(readOnlyRes.status).toBe(201);
    const { token: readOnlyToken } = await readOnlyRes.json<{
      token: string;
    }>();

    const forbiddenPatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token: readOnlyToken,
        body: JSON.stringify({ status: "failed" }),
      }),
      env
    );
    expect(forbiddenPatchRes.status).toBe(403);
  });

  it("creates a child issue and dispatches a child session", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const parent = await stub.createIssue({
      title: "Parent issue",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: parent.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const childRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child task", agentId: "mock" }),
        }
      ),
      env
    );
    expect(childRes.status).toBe(201);
    const child = await childRes.json<{
      session: { id: string; issueId: string };
      issue: { id: string; parentId: string };
    }>();
    expect(child.issue.parentId).toBe(parent.id);
    expect(child.session.issueId).toBe(child.issue.id);

    const secondRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child 2", agentId: "mock" }),
        }
      ),
      env
    );
    expect(secondRes.status).toBe(201);

    const thirdRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child 3", agentId: "mock" }),
        }
      ),
      env
    );
    expect(thirdRes.status).toBe(429);
  });

  it("streams session events as SSE with Last-Event-ID support", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Stream test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const streamRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stream`,
        { token }
      ),
      env
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toBe("text/event-stream");

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    const patchResPromise = app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );

    let buffer = "";
    let found = false;
    while (!found) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: session.status")) {
        found = true;
      }
    }
    await reader.cancel();
    await patchResPromise;

    expect(found).toBe(true);
    expect(buffer).toContain('"type":"session.status"');
    expect(buffer).toContain('"new":"running"');

    const lastEventIdMatch = buffer.match(/id: (\d+)/);
    expect(lastEventIdMatch).not.toBeNull();
    const lastEventId = Number(lastEventIdMatch![1]);

    const reconnectRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stream`,
        {
          token,
          headers: { "Last-Event-ID": String(lastEventId) },
        }
      ),
      env
    );
    expect(reconnectRes.status).toBe(200);
    await reconnectRes.body?.cancel?.();
  });

  it("probes provider health", async () => {
    registerAgentProvider(
      "healthy",
      () =>
        new MockAgentProvider("healthy", {
          health: () => ({ ok: true, message: "up" }),
        })
    );
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/healthy/health`, {
        method: "POST",
        token,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; message?: string }>();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("up");
  });

  it("applies inbound provider webhooks onto the matching session", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Webhook test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-webhook-1",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/mock/hooks`, {
        method: "POST",
        token,
        body: JSON.stringify({
          session_id: "remote-webhook-1",
          status: "completed",
          result: "done via hook",
        }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; sessionId: string }>();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(session.id);

    const got = await stub.getAgentSession(session.id);
    expect(got?.status).toBe("completed");
    expect(got?.result).toBe("done via hook");
  });

  it("redacts credential pool secrets from provider config responses", async () => {
    const put = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/mock`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          config: {
            model: "sonnet",
            credentialPool: [
              {
                kind: "claudeSubscription",
                secret: "sk-ant-oat01-secret",
                label: "max",
                purposes: ["review"],
              },
            ],
          },
        }),
      }),
      env
    );
    expect(put.status).toBe(200);
    const saved = await put.json<{
      config: { model?: string; credentialPool?: unknown };
    }>();
    expect(saved.config.model).toBe("sonnet");
    expect(saved.config.credentialPool).toEqual([
      { kind: "claudeSubscription", label: "max", purposes: ["review"] },
    ]);
    expect(JSON.stringify(saved)).not.toContain("sk-ant-oat01-secret");
  });

  it("accepts inbound provider webhooks with a configured secret", async () => {
    const put = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/mock`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          config: { webhookSecret: "hook-secret" },
        }),
      }),
      env
    );
    expect(put.status).toBe(200);
    const saved = await put.json<{
      config: { hasWebhookSecret?: boolean; webhookSecret?: string };
    }>();
    expect(saved.config.hasWebhookSecret).toBe(true);
    expect(saved.config.webhookSecret).toBeUndefined();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Inbound webhook",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-inbound-1",
    });

    const denied = await app.fetch(
      request(`/webhooks/agent/${organizationId}/mock`, {
        method: "POST",
        body: JSON.stringify({
          session_id: "remote-inbound-1",
          status: "failed",
        }),
      }),
      env
    );
    expect(denied.status).toBe(401);

    const res = await app.fetch(
      request(`/webhooks/agent/${organizationId}/mock`, {
        method: "POST",
        headers: { "X-Pile-Webhook-Secret": "hook-secret" },
        body: JSON.stringify({
          session_id: "remote-inbound-1",
          status: "failed",
          result: "provider push",
        }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const got = await stub.getAgentSession(session.id);
    expect(got?.status).toBe("failed");
    expect(got?.result).toBe("provider push");
  });

  it("captures a PR URL from poll as a session artifact", async () => {
    registerAgentProvider(
      "pr-mock",
      () =>
        new MockAgentProvider("pr-mock", {
          dispatch: (_org, issue) => ({
            id: "pr-remote",
            agentId: "pr-mock",
            issueId: issue.id,
            status: "running",
          }),
          poll: (sessionId) => ({
            id: sessionId,
            agentId: "pr-mock",
            status: "running",
            prUrl: "https://github.com/VortexNYC/pile/pull/999",
            prState: "open",
          }),
        })
    );
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "PR artifact",
          repo: "VortexNYC/pile",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();
    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "pr-mock" }),
      }),
      env
    );
    const session = await dispatchRes.json<{ id: string }>();
    const pollRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/poll`,
        { method: "POST", token }
      ),
      env
    );
    expect(pollRes.status).toBe(200);
    const polled = await pollRes.json<{
      activities: Array<{ type: string; payload: { url?: string } | null }>;
    }>();
    const artifact = polled.activities.find((a) => a.type === "artifact");
    expect(artifact?.payload?.url).toBe(
      "https://github.com/VortexNYC/pile/pull/999"
    );
  });

  it("guards the lane github-token mint with per-session token auth", async () => {
    const sessionId = crypto.randomUUID();
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      sessionId
    );
    const base = `/workspaces/${organizationId}/agent/sessions/${sessionId}/github-token`;

    const noAuth = await app.fetch(request(base, { method: "POST" }), env);
    expect([401, 403]).toContain(noAuth.status);

    const badToken = await app.fetch(
      request(base, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    );
    expect(badToken.status).toBe(401);

    // Valid lane token, unknown session → 404 (token can't mint for another
    // session id, and a real session is required to resolve the repo).
    const unknown = await app.fetch(
      request(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
      }),
      env
    );
    expect(unknown.status).toBe(404);
  });

  it("serves the runner pnpm-store cache with per-session token auth", async () => {
    const sessionId = crypto.randomUUID();
    const cacheToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      sessionId
    );
    const hash = "ab".repeat(32);
    const base = `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${hash}`;

    // No credentials at all: rejected by CSRF middleware before the route.
    const noAuth = await app.fetch(
      request(base, { method: "PUT", body: "store-bytes" }),
      env
    );
    expect([401, 403]).toContain(noAuth.status);

    const badToken = await app.fetch(
      request(base, {
        method: "PUT",
        body: "store-bytes",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    );
    expect(badToken.status).toBe(401);

    const badHash = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/nothex`,
        {
          method: "PUT",
          body: "x",
          headers: { Authorization: `Bearer ${cacheToken}` },
        }
      ),
      env
    );
    expect(badHash.status).toBe(401);

    const put = await app.fetch(
      request(base, {
        method: "PUT",
        body: "store-bytes",
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(put.status).toBe(200);

    const get = await app.fetch(
      request(base, {
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("store-bytes");

    // Multipart path: parts + manifest reassemble into one stream.
    const mhash = "ef".repeat(32);
    const mbase = `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${mhash}`;
    for (const [i, chunk] of ["part-a-", "part-b"].entries()) {
      const res = await app.fetch(
        request(`${mbase}/parts/${i}`, {
          method: "PUT",
          body: chunk,
          headers: { Authorization: `Bearer ${cacheToken}` },
        }),
        env
      );
      expect(res.status).toBe(200);
    }
    const man = await app.fetch(
      request(`${mbase}/manifest`, {
        method: "PUT",
        body: JSON.stringify({ parts: 2 }),
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(man.status).toBe(200);
    const joined = await app.fetch(
      request(mbase, { headers: { Authorization: `Bearer ${cacheToken}` } }),
      env
    );
    expect(joined.status).toBe(200);
    expect(await joined.text()).toBe("part-a-part-b");

    const miss = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${"cd".repeat(32)}`,
        { headers: { Authorization: `Bearer ${cacheToken}` } }
      ),
      env
    );
    expect(miss.status).toBe(404);
  });

  it("registers an external agent session and returns lane credentials", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "External session",
      repo: "VortexNYC/pile",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "cursor-cloud",
          providerSessionId: "cursor-ext-1",
          status: "running",
          url: "https://cursor.com/agents/abc",
          branch: "cursor/fix-thing",
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      session: { id: string; providerSessionId: string | null; status: string };
      laneToken: string;
      logUrl: string | null;
      reportUrl: string | null;
    }>();
    expect(body.session.providerSessionId).toBe("cursor-ext-1");
    expect(body.session.status).toBe("running");
    expect(body.laneToken).toBeTruthy();
    expect(body.reportUrl).toContain(
      `/agent/sessions/${body.session.id}/report`
    );

    // Re-registering the same provider session dedupes to the same row.
    const again = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "cursor-cloud",
          providerSessionId: "cursor-ext-1",
        }),
      }),
      env
    );
    expect(again.status).toBe(200);
    const againBody = await again.json<{ session: { id: string } }>();
    expect(againBody.session.id).toBe(body.session.id);
  });

  it("rejects registration for a missing issue", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: crypto.randomUUID(),
          provider: "cursor-cloud",
        }),
      }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("lets a registered external session report via its lane token", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Report test",
      repo: "VortexNYC/pile",
    });
    const reg = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({ issueId: issue.id, provider: "custom-bot" }),
      }),
      env
    );
    const { session, laneToken } = await reg.json<{
      session: { id: string };
      laneToken: string;
    }>();
    const reportBase = `/workspaces/${organizationId}/agent/sessions/${session.id}/report`;

    // No token / wrong token → 401.
    const noAuth = await app.fetch(
      request(reportBase, {
        method: "POST",
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect([401, 403]).toContain(noAuth.status);
    const badToken = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(badToken.status).toBe(401);

    // A lane token minted for a *different* session must not work here.
    const otherToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      crypto.randomUUID()
    );
    const cross = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(cross.status).toBe(401);

    // Invalid status rejected.
    const badStatus = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "exploded" }),
      }),
      env
    );
    expect(badStatus.status).toBe(400);

    // Non-lifecycle fields land.
    const fields = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          url: "https://example.com/run",
          branch: "bot/branch",
          prUrl: "https://github.com/VortexNYC/pile/pull/999",
        }),
      }),
      env
    );
    expect(fields.status).toBe(200);
    const got = await stub.getAgentSession(session.id);
    expect(got?.branch).toBe("bot/branch");
    expect(got?.prUrl).toBe("https://github.com/VortexNYC/pile/pull/999");
    expect(got?.lastProgressAt).toBeTruthy();

    // Terminal transition flows through the result path.
    const done = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "completed", result: "all done" }),
      }),
      env
    );
    expect(done.status).toBe(200);
    const final = await stub.getAgentSession(session.id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toBe("all done");
    // A bare status report must not wipe fields set by earlier reports —
    // caught live: the completion report nulled prUrl/branch.
    expect(final?.prUrl).toBe("https://github.com/VortexNYC/pile/pull/999");
    expect(final?.branch).toBe("bot/branch");

    // Terminal sessions refuse further reports.
    const after = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(after.status).toBe(409);
  });

  it("keeps a live progress comment on the issue for a reporting lane (PILE-290)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Progress comment test",
      repo: "VortexNYC/pile",
    });
    const reg = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "progress-bot",
          status: "created",
          url: "https://example.com/run/progress",
        }),
      }),
      env
    );
    const { session, laneToken } = await reg.json<{
      session: { id: string };
      laneToken: string;
    }>();
    const report = (body: unknown) =>
      app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${session.id}/report`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${laneToken}` },
            body: JSON.stringify(body),
          }
        ),
        env
      );
    const progressComments = async () =>
      (await stub.listComments(issue.id)).filter(
        (c) => c.externalId === `${session.id}:progress`
      );

    expect(await progressComments()).toHaveLength(0);

    // First `running` report posts the comment immediately.
    expect(
      (await report({ status: "running", step: "Reading issue" })).status
    ).toBe(200);
    let [progress] = await progressComments();
    expect(progress?.body).toContain("is on it");
    expect(progress?.body).toContain("https://example.com/run/progress");
    expect(progress?.body).toContain("Current step: Reading issue");
    expect(progress?.body).toContain("ETA:");

    // Task-list reports edit the same comment in place.
    expect(
      (
        await report({
          todos: [
            { content: "Reading issue", status: "completed" },
            { content: "Writing tests", status: "in_progress" },
          ],
        })
      ).status
    ).toBe(200);
    const edited = await progressComments();
    expect(edited).toHaveLength(1);
    progress = edited[0];
    expect(progress?.body).toContain("Current step: Writing tests");
    expect(progress?.body).toContain("- [x] Reading issue");
    expect(progress?.body).toContain("- [ ] Writing tests _(in progress)_");

    expect(
      (await report({ todos: [{ content: "", status: "nope" }] })).status
    ).toBe(400);

    // Terminal: progress comment freezes; the result comment still lands.
    expect(
      (await report({ status: "completed", result: "shipped" })).status
    ).toBe(200);
    const final = await progressComments();
    expect(final).toHaveLength(1);
    expect(final[0]?.body).toContain("completed** after");
    expect(final[0]?.body).not.toContain("ETA:");
    const all = await stub.listComments(issue.id);
    expect(all.some((c) => c.body.includes("completed: shipped"))).toBe(true);
  });

  it("publishes and replaces a session plan via PATCH and lane report (PILE-426)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Plan checklist API",
      repo: "VortexNYC/pile",
    });
    const reg = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "plan-bot",
          status: "running",
        }),
      }),
      env
    );
    const { session, laneToken } = await reg.json<{
      session: { id: string };
      laneToken: string;
    }>();
    const sessionPath = `/workspaces/${organizationId}/agent/sessions/${session.id}`;
    const plan = [
      { content: "Read the issue", status: "completed" },
      { content: "Write the fix", status: "inProgress" },
      { content: "Open the PR", status: "pending" },
    ];

    // PATCH publishes the plan; the session response carries it parsed.
    const patched = await app.fetch(
      request(sessionPath, {
        method: "PATCH",
        token,
        body: JSON.stringify({ plan }),
      }),
      env
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json<{ plan?: unknown }>();
    expect(patchedBody.plan).toEqual(plan);
    const fetched = await app.fetch(request(sessionPath, { token }), env);
    expect((await fetched.json<{ plan?: unknown }>()).plan).toEqual(plan);

    // A lane self-report replaces the whole array — no per-item patching.
    const reported = await app.fetch(
      request(`${sessionPath}/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          plan: [
            { content: "Write the fix", status: "completed" },
            { content: "Open the PR", status: "inProgress" },
          ],
        }),
      }),
      env
    );
    expect(reported.status).toBe(200);
    const afterReport = await stub.getAgentSession(session.id);
    expect(JSON.parse(afterReport?.plan ?? "null")).toEqual([
      { content: "Write the fix", status: "completed" },
      { content: "Open the PR", status: "inProgress" },
    ]);

    // Each publish lands a session.plan event; the live progress comment
    // renders the checklist on the issue.
    const events = await app.fetch(
      request(`${sessionPath}/events?limit=100`, { token }),
      env
    );
    const eventsBody = await events.json<{
      events: Array<{ type: string; message: string }>;
    }>();
    const planEvents = eventsBody.events.filter(
      (e) => e.type === "session.plan"
    );
    expect(planEvents.length).toBeGreaterThanOrEqual(2);
    const progress = (await stub.listComments(issue.id)).find(
      (c) => c.externalId === `${session.id}:progress`
    );
    expect(progress?.body).toContain("**Plan**");
    expect(progress?.body).toContain("- [ ] Open the PR _(in progress)_");

    // Malformed plans are rejected on both write paths.
    const badReport = await app.fetch(
      request(`${sessionPath}/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          plan: [{ content: "x", status: "in_progress" }],
        }),
      }),
      env
    );
    expect(badReport.status).toBe(400);
    const badPatch = await app.fetch(
      request(sessionPath, {
        method: "PATCH",
        token,
        body: JSON.stringify({ plan: [{ content: "", status: "pending" }] }),
      }),
      env
    );
    expect(badPatch.status).toBe(400);

    // A plan published alongside a terminal report survives on the row.
    const done = await app.fetch(
      request(`${sessionPath}/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          status: "completed",
          result: "shipped",
          plan: [
            { content: "Write the fix", status: "completed" },
            { content: "Open the PR", status: "completed" },
          ],
        }),
      }),
      env
    );
    expect(done.status).toBe(200);
    const final = await stub.getAgentSession(session.id);
    expect(final?.status).toBe("completed");
    expect(JSON.parse(final?.plan ?? "null")).toEqual([
      { content: "Write the fix", status: "completed" },
      { content: "Open the PR", status: "completed" },
    ]);
    // Terminal sessions refuse further plan reports.
    const late = await app.fetch(
      request(`${sessionPath}/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          plan: [{ content: "zombie", status: "pending" }],
        }),
      }),
      env
    );
    expect(late.status).toBe(409);
  });

  it("lets a lane token read back its own session and events (PILE-232)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Lane read test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "lane-read-1",
    });
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      session.id
    );

    // PILE-418 — a fresh dispatch sits inside the ~10s first-ack window:
    // firstActivityAt is unset and the lane is not flagged.
    expect(
      (session as { firstActivityAt?: string | null }).firstActivityAt ?? null
    ).toBeNull();
    expect(
      (session as { awaitingFirstAck?: boolean }).awaitingFirstAck ?? false
    ).toBe(false);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${laneToken}` },
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ id: string; status: string }>();
    expect(got.id).toBe(session.id);

    const evRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { headers: { Authorization: `Bearer ${laneToken}` } }
      ),
      env
    );
    expect(evRes.status).toBe(200);

    // No prUrl → checks resolves empty without touching GitHub.
    const checksRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/checks`,
        { headers: { Authorization: `Bearer ${laneToken}` } }
      ),
      env
    );
    expect(checksRes.status).toBe(200);
    const checks = await checksRes.json<{ checks: unknown[] }>();
    expect(checks.checks).toEqual([]);

    // A token minted for a different session cannot read this one.
    const foreign = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      crypto.randomUUID()
    );
    const cross = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${foreign}` },
      }),
      env
    );
    expect([401, 403]).toContain(cross.status);

    // No credentials → not a lane request, falls to workspace auth → 401.
    const anon = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`),
      env
    );
    expect([401, 403]).toContain(anon.status);

    // Workspace tokens keep working on the same path (no regression).
    const wsRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    expect(wsRes.status).toBe(200);
  });

  describe("dispatch-batch", () => {
    // Separate workspace: the shared org accumulates live sessions across the
    // suite and trips the per-workspace active-lane ceiling.
    let batchOrg: string;
    let batchToken: string;

    beforeAll(async () => {
      const db = createD1(env.D1);
      const headers = await createAdminHeaders(env, "user-1");
      const workspace = await createWorkspace(db, env, headers, {
        name: "Batch dispatch tests",
        slug: `batch-dispatch-${crypto.randomUUID()}`,
        ownerId: "user-1",
      });
      batchOrg = workspace!.id;
      const auth = await createAuth(env);
      const result = await auth.api.createApiKey({
        body: {
          userId: "user-1",
          name: "batch-dispatch",
          metadata: { organizationId: batchOrg, permissions: "admin" },
        },
      });
      batchToken = z.object({ key: z.string() }).parse(result).key;
    });

    const createIssue = async (title: string) => {
      const res = await app.fetch(
        request(`/workspaces/${batchOrg}/issues`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ title }),
        }),
        env
      );
      expect(res.status).toBe(201);
      return (await res.json<{ id: string }>()).id;
    };

    type BatchResult = {
      issueId: string;
      sessionId: string | null;
      status: string | null;
      error: string | null;
    };

    const postBatch = (items: unknown[]) =>
      app.fetch(
        request(`/workspaces/${batchOrg}/agent/dispatch-batch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ items }),
        }),
        env
      );

    it("dispatches every item in one call and returns all session ids", async () => {
      const issueIds = await Promise.all([
        createIssue("Batch lane one"),
        createIssue("Batch lane two"),
        createIssue("Batch lane three"),
      ]);

      const res = await postBatch(
        issueIds.map((issueId) => ({ issueId, agentId: "mock" }))
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        batchId: string;
        results: BatchResult[];
      }>();
      expect(body.batchId).toBeTruthy();
      expect(body.results).toHaveLength(3);
      for (const [index, result] of body.results.entries()) {
        expect(result.issueId).toBe(issueIds[index]);
        expect(result.sessionId).toBeTruthy();
        expect(result.status).toBe("created");
        expect(result.error).toBeNull();
      }

      // Each issue got its session plus an activity noting the batch.
      for (const [index, result] of body.results.entries()) {
        const sessionsRes = await app.fetch(
          request(
            `/workspaces/${batchOrg}/agent/sessions?issueId=${issueIds[index]}`,
            { token: batchToken }
          ),
          env
        );
        const sessions = await sessionsRes.json<{
          sessions: { id: string }[];
        }>();
        expect(sessions.sessions.map((s) => s.id)).toContain(result.sessionId);

        const activityRes = await app.fetch(
          request(
            `/workspaces/${batchOrg}/issues/${issueIds[index]}/activity`,
            { token: batchToken }
          ),
          env
        );
        const feed = await activityRes.json<{
          activity: { kind: string; message?: string }[];
        }>();
        const batchNote = feed.activity.find(
          (a) => a.kind === "agent" && a.message?.includes(body.batchId)
        );
        expect(batchNote).toBeTruthy();
      }
    });

    it("reports a conflicted item's error without failing the rest", async () => {
      const conflicted = await createIssue("Already has a lane");
      const ok = await createIssue("Fresh lane");

      const first = await app.fetch(
        request(`/workspaces/${batchOrg}/issues/${conflicted}/dispatch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ agentId: "mock" }),
        }),
        env
      );
      expect(first.status).toBe(201);

      const res = await postBatch([
        { issueId: conflicted, agentId: "mock" },
        { issueId: ok, agentId: "mock" },
        { issueId: "missing-issue-id", agentId: "mock" },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results).toHaveLength(3);
      expect(body.results[0].sessionId).toBeNull();
      expect(body.results[0].error).toContain("active agent session");
      expect(body.results[1].sessionId).toBeTruthy();
      expect(body.results[1].error).toBeNull();
      expect(body.results[2].sessionId).toBeNull();
      expect(body.results[2].error).toBe("Issue not found");
    });

    it("queues an item behind a sibling item via queuedAfter", async () => {
      const blocker = await createIssue("Runs first");
      const queued = await createIssue("Runs after");

      const res = await postBatch([
        { issueId: blocker, agentId: "mock" },
        { issueId: queued, agentId: "mock", queuedAfter: blocker },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].status).toBe("created");
      expect(body.results[1].status).toBe("waiting");
      expect(body.results[1].sessionId).toBeTruthy();

      const sessionRes = await app.fetch(
        request(
          `/workspaces/${batchOrg}/agent/sessions/${body.results[1].sessionId}`,
          { token: batchToken }
        ),
        env
      );
      const session = await sessionRes.json<{
        status: string;
        queuedAfter: string | null;
      }>();
      expect(session.status).toBe("waiting");
      expect(session.queuedAfter).toBe(body.results[0].sessionId);
    });

    it("queues an item behind an existing session id", async () => {
      const blocker = await createIssue("Lane already running");
      const queued = await createIssue("Parks behind it");

      const first = await app.fetch(
        request(`/workspaces/${batchOrg}/issues/${blocker}/dispatch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ agentId: "mock" }),
        }),
        env
      );
      const blockerSession = await first.json<{ id: string }>();

      const res = await postBatch([
        {
          issueId: queued,
          agentId: "mock",
          queuedAfter: blockerSession.id,
        },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].status).toBe("waiting");
      expect(body.results[0].sessionId).toBeTruthy();
    });

    it("fails the dependent item when its queuedAfter sibling fails", async () => {
      const missing = "missing-sibling-issue";
      const queued = await createIssue("Orphaned dependent");

      const res = await postBatch([
        { issueId: missing, agentId: "mock" },
        { issueId: queued, agentId: "mock", queuedAfter: missing },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].error).toBe("Issue not found");
      expect(body.results[1].sessionId).toBeNull();
      expect(body.results[1].error).toContain("queuedAfter target failed");
    });
  });

  // PILE-321 — a repo-less issue inherits its team's defaultRepo at dispatch
  // so the lane produces a PR instead of a spec-only package. Separate
  // workspace: the shared org accumulates live sessions and trips the
  // per-workspace active-lane ceiling.
  describe("team defaultRepo dispatch", () => {
    let repoOrg: string;
    let repoToken: string;
    const teamRepo = "VortexNYC/team-default";
    let teamId: string;

    beforeAll(async () => {
      const db = createD1(env.D1);
      const headers = await createAdminHeaders(env, "user-1");
      const workspace = await createWorkspace(db, env, headers, {
        name: "DefaultRepo dispatch tests",
        slug: `default-repo-${crypto.randomUUID()}`,
        ownerId: "user-1",
      });
      repoOrg = workspace!.id;
      const team = await createTeam(db, env, new Headers(), {
        organizationId: repoOrg,
        key: "TD",
        name: "Defaulted",
        ownerId: "user-1",
        defaultRepo: teamRepo,
      });
      teamId = team.id;
      const auth = await createAuth(env);
      const result = await auth.api.createApiKey({
        body: {
          userId: "user-1",
          name: "default-repo",
          metadata: { organizationId: repoOrg, permissions: "admin" },
        },
      });
      repoToken = z.object({ key: z.string() }).parse(result).key;
    });

    // Explicit repo:null keeps the issue repo-less even on a defaulted team,
    // so the dispatch-time fallback is what's under test.
    const createRepolessIssue = async (title: string) => {
      const res = await app.fetch(
        request(`/workspaces/${repoOrg}/issues`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({ title, teamId, repo: null }),
        }),
        env
      );
      expect(res.status).toBe(201);
      const issue = await res.json<{ id: string; repo: string | null }>();
      expect(issue.repo).toBeNull();
      return issue;
    };

    const issueRepo = async (issueId: string) => {
      const res = await app.fetch(
        request(`/workspaces/${repoOrg}/issues/${issueId}`, {
          token: repoToken,
        }),
        env
      );
      return (await res.json<{ repo: string | null }>()).repo;
    };

    it("inherits the team's defaultRepo when dispatching a repo-less issue", async () => {
      const agentId = `mock-inherit-${crypto.randomUUID().slice(0, 8)}`;
      let seenRepo: string | null | undefined;
      registerAgentProvider(
        agentId,
        () =>
          new MockAgentProvider(agentId, {
            dispatch: (_org, dispatchedIssue) => {
              seenRepo = dispatchedIssue.repo;
              return {
                id: `inherit-${crypto.randomUUID()}`,
                agentId,
                issueId: dispatchedIssue.id,
                status: "created" as const,
              };
            },
          })
      );
      const issue = await createRepolessIssue("Repo-less on a defaulted team");

      const dispatchRes = await app.fetch(
        request(`/workspaces/${repoOrg}/issues/${issue.id}/dispatch`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({ agentId }),
        }),
        env
      );
      expect(dispatchRes.status).toBe(201);
      expect(seenRepo).toBe(teamRepo);

      // The inherited repo is persisted — lane-token minting and
      // redispatches read issue.repo, not the dispatch-time target.
      expect(await issueRepo(issue.id)).toBe(teamRepo);
    });

    it("prefers an explicit dispatch repo over the team defaultRepo", async () => {
      const agentId = `mock-override-${crypto.randomUUID().slice(0, 8)}`;
      let seenRepo: string | null | undefined;
      registerAgentProvider(
        agentId,
        () =>
          new MockAgentProvider(agentId, {
            dispatch: (_org, dispatchedIssue) => {
              seenRepo = dispatchedIssue.repo;
              return {
                id: `override-${crypto.randomUUID()}`,
                agentId,
                issueId: dispatchedIssue.id,
                status: "created" as const,
              };
            },
          })
      );
      const issue = await createRepolessIssue("Explicit repo wins");

      const dispatchRes = await app.fetch(
        request(`/workspaces/${repoOrg}/issues/${issue.id}/dispatch`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({ agentId, repo: "VortexNYC/override" }),
        }),
        env
      );
      expect(dispatchRes.status).toBe(201);
      expect(seenRepo).toBe("VortexNYC/override");
      // The override is per-dispatch — the stored issue stays repo-less.
      expect(await issueRepo(issue.id)).toBeNull();
    });

    it("stays repo-less when dispatch passes repo: null explicitly", async () => {
      const agentId = `mock-norepo-${crypto.randomUUID().slice(0, 8)}`;
      let seenRepo: string | null | undefined;
      registerAgentProvider(
        agentId,
        () =>
          new MockAgentProvider(agentId, {
            dispatch: (_org, dispatchedIssue) => {
              seenRepo = dispatchedIssue.repo;
              return {
                id: `norepo-${crypto.randomUUID()}`,
                agentId,
                issueId: dispatchedIssue.id,
                status: "created" as const,
              };
            },
          })
      );
      const issue = await createRepolessIssue("Explicit repo-less lane");

      const dispatchRes = await app.fetch(
        request(`/workspaces/${repoOrg}/issues/${issue.id}/dispatch`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({ agentId, repo: null }),
        }),
        env
      );
      expect(dispatchRes.status).toBe(201);
      expect(seenRepo).toBeNull();
      expect(await issueRepo(issue.id)).toBeNull();
    });

    it("inherits the team's defaultRepo in dispatch-batch", async () => {
      const issue = await createRepolessIssue("Repo-less batch item");
      const res = await app.fetch(
        request(`/workspaces/${repoOrg}/agent/dispatch-batch`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({
            items: [{ issueId: issue.id, agentId: "mock" }],
          }),
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        results: { sessionId: string | null; error: string | null }[];
      }>();
      expect(body.results[0].sessionId).toBeTruthy();
      expect(body.results[0].error).toBeNull();
      expect(await issueRepo(issue.id)).toBe(teamRepo);
    });

    it("retry inherits the team's defaultRepo for a pre-repo lane", async () => {
      const agentId = `mock-retry-${crypto.randomUUID().slice(0, 8)}`;
      let seenRepo: string | null | undefined;
      registerAgentProvider(
        agentId,
        () =>
          new MockAgentProvider(agentId, {
            dispatch: (_org, dispatchedIssue) => {
              seenRepo = dispatchedIssue.repo;
              return {
                id: `retry-${crypto.randomUUID()}`,
                agentId,
                issueId: dispatchedIssue.id,
                status: "created" as const,
              };
            },
          })
      );
      const issue = await createRepolessIssue("Retry inherits the default");
      const stub = env.WORKSPACE_DURABLE_OBJECT.get(
        env.WORKSPACE_DURABLE_OBJECT.idFromName(repoOrg)
      );
      const session = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: "user-1",
        actorType: "user",
        status: "completed",
        result: "spec-only run",
      });

      const retryRes = await app.fetch(
        request(`/workspaces/${repoOrg}/agent/sessions/${session.id}/retry`, {
          method: "POST",
          token: repoToken,
          body: JSON.stringify({ context: "try again with the repo" }),
        }),
        env
      );
      expect(retryRes.status).toBe(201);
      expect(seenRepo).toBe(teamRepo);
      expect(await issueRepo(issue.id)).toBe(teamRepo);
    });
  });

  describe("fleet-health", () => {
    it("counts only unreaped in-window sessions on sandbox-keeping providers", async () => {
      const keepId = `mock-kept-${crypto.randomUUID().slice(0, 8)}`;
      const dropId = `mock-gone-${crypto.randomUUID().slice(0, 8)}`;
      registerAgentProvider(
        keepId,
        () => new MockAgentProvider(keepId, { keepsTerminalSandbox: true })
      );
      registerAgentProvider(dropId, () => new MockAgentProvider(dropId));

      const stub = env.WORKSPACE_DURABLE_OBJECT.get(
        env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
      );
      await stub.setOrganizationId(organizationId);
      const issue = await stub.createIssue({ title: "Fleet kept" });
      const terminal = async (agentId: string, reaped = false) => {
        const session = await stub.createAgentSession({
          issueId: issue.id,
          agentId,
          provider: agentId,
          actorId: "user-1",
          actorType: "user",
          status: "completed",
        });
        await stub.updateAgentSession(session.id, {
          endedAt: new Date().toISOString(),
          ...(reaped ? { lastStateHash: "reaped" } : {}),
        });
      };
      await terminal(keepId);
      await terminal(keepId);
      // Destroyed by the reaper — must drop out of the count now, not when
      // the row ages out of the resume window (PILE-253).
      await terminal(keepId, true);
      // This provider deletes its sandbox at terminal — never a kept
      // sandbox regardless of the resume window.
      await terminal(dropId);

      const res = await app.fetch(
        request(`/workspaces/${organizationId}/agent/fleet-health`, {
          token,
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        providers: { agentId: string; keptSandboxes: number }[];
      }>();
      expect(
        body.providers.find((p) => p.agentId === keepId)?.keptSandboxes
      ).toBe(2);
      expect(
        body.providers.find((p) => p.agentId === dropId)?.keptSandboxes ?? 0
      ).toBe(0);
    });
  });

  it("queues a follow-up prompt as an event on externally-managed sessions", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Local agent loop" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();
    // A self-registered local session: no providerSessionId, no live
    // sandbox for sendPrompt — the prompt must land as a readable event.
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "local-agent",
      provider: "local-agent",
      actorId: "user-1",
      actorType: "agent",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/prompt`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ prompt: "status report please" }),
        }
      ),
      env
    );
    expect(res.status).toBe(200);

    const events = await stub.listAgentSessionEvents(session.id, {});
    const evt = events.find((e) => e.type === "prompt.followup");
    expect(evt).toBeDefined();
    const payload = JSON.parse(evt?.payload ?? "{}") as {
      prompt?: string;
      delivery?: string;
    };
    expect(payload.prompt).toBe("status report please");
    expect(payload.delivery).toBe("queued");
  });

  it("stops a running session: session.stopped event, provider cancel, terminal activities rejected", async () => {
    const agentId = `mock-stop-${crypto.randomUUID().slice(0, 8)}`;
    const cancels: string[] = [];
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          cancel: (id) => {
            cancels.push(id);
          },
        })
    );
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Stop target" }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "prov-stop-1",
      startedAt: new Date().toISOString(),
    });

    const stopRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stop`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ reason: "operator abort" }),
        }
      ),
      env
    );
    expect(stopRes.status).toBe(200);
    const stopped = await stopRes.json<{ status: string; result: string }>();
    expect(stopped.status).toBe("canceled");
    expect(stopped.result).toContain("Stopped by");
    expect(stopped.result).toContain("operator abort");
    expect(cancels).toEqual(["prov-stop-1"]);

    const events = await stub.listAgentSessionEvents(session.id, {});
    const evt = events.find((e) => e.type === "session.stopped");
    expect(evt).toBeDefined();
    expect(JSON.parse(evt?.payload ?? "{}")).toMatchObject({
      actorId: expect.any(String),
      reason: "operator abort",
    });

    // Terminal sessions accept no further activities (PILE-420).
    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ type: "thought", message: "too late" }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(409);

    // Stopping again is a no-op, not a second event.
    const again = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stop`,
        { method: "POST", token, body: JSON.stringify({}) }
      ),
      env
    );
    expect(again.status).toBe(200);
    const stoppedEvents = (
      await stub.listAgentSessionEvents(session.id, {})
    ).filter((e) => e.type === "session.stopped");
    expect(stoppedEvents).toHaveLength(1);
  });

  it("pauses an agent type, holds dispatches, and drains them on resume", async () => {
    const agentId = `mock-ptype-${crypto.randomUUID().slice(0, 8)}`;
    const dispatches: string[] = [];
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, _issue, _model, ctx) => {
            dispatches.push(ctx?.sessionId ?? "");
            return {
              id: `prov-${ctx?.sessionId}`,
              agentId,
              status: "running" as const,
            };
          },
        })
    );

    const pauseRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/pauses/${agentId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({ reason: "rolling brownout" }),
      }),
      env
    );
    expect(pauseRes.status).toBe(200);
    const pause = await pauseRes.json<{ agentId: string; reason: string }>();
    expect(pause.agentId).toBe(agentId);
    expect(pause.reason).toBe("rolling brownout");

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/pauses`, { token }),
      env
    );
    const { pauses } = await listRes.json<{
      pauses: Array<{ agentId: string }>;
    }>();
    expect(pauses.some((p) => p.agentId === agentId)).toBe(true);

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Paused dispatch" }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();
    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const dispatched = await dispatchRes.json<{
      id: string;
      status: string;
      paused: number;
    }>();
    expect(dispatched.status).toBe("waiting");
    expect(dispatched.paused).toBe(1);
    expect(dispatches).toHaveLength(0);

    const resumeRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/pauses/${agentId}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(resumeRes.status).toBe(200);
    const resumed = await resumeRes.json<{
      ok: boolean;
      released: string[];
    }>();
    expect(resumed.released).toEqual([dispatched.id]);
    expect(dispatches).toEqual([dispatched.id]);

    // Resume with nothing paused and nothing held 404s.
    const absent = await app.fetch(
      request(`/workspaces/${organizationId}/agent/pauses/${agentId}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(absent.status).toBe(404);
  });

  it("batch dispatch persists stepKey and the session response carries guidance refs", async () => {
    const agentId = `mock-batch-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));

    // The workspace-wide lane ceiling (25 live lanes) trips on the shared
    // test org's accumulated sessions — clear them so this item dispatches.
    const sweepStub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await sweepStub.setOrganizationId(organizationId);
    for (const s of await sweepStub.listAgentSessions({ limit: 200 })) {
      if (!["completed", "failed", "canceled"].includes(s.status)) {
        await sweepStub.applyAgentSessionResult(
          s.id,
          { status: "canceled" },
          "user-1"
        );
      }
    }

    // A step-scoped pack that only matches the dispatch's stepKey.
    const packRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/guidance`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Contacted step",
          scope: "step",
          scopeKey: "contacted",
          body: "Human approval required.",
        }),
      }),
      env
    );
    expect(packRes.status).toBe(201);

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Batch stepKey dispatch" }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const batchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/dispatch-batch`, {
        method: "POST",
        token,
        body: JSON.stringify({
          items: [{ issueId: issue.id, agentId, stepKey: "contacted" }],
        }),
      }),
      env
    );
    expect(batchRes.status).toBe(200);
    const batch = await batchRes.json<{
      results: Array<{ sessionId: string | null; error: string | null }>;
    }>();
    expect(batch.results[0]?.error).toBeNull();
    const sessionId = batch.results[0]!.sessionId;
    expect(sessionId).toBeTruthy();

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${sessionId}`, {
        token,
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const session = await getRes.json<{
      status: string;
      stepKey: string | null;
      guidance: Array<{
        name: string;
        scope: string;
        scopeKey: string | null;
      }> | null;
    }>();
    expect(session.stepKey).toBe("contacted");
    expect(
      session.guidance?.some(
        (g) => g.name === "Contacted step" && g.scope === "step"
      )
    ).toBe(true);
  });
});

describe("spend caps + run receipts (PILE-425)", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const headers = await createAdminHeaders(env, "user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Spend caps test",
      slug: `spend-caps-${crypto.randomUUID().slice(0, 8)}`,
      ownerId: "user-1",
    });
    organizationId = workspace!.id;
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "caps-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
  });

  it("upserts, lists, and deletes spend caps", async () => {
    const agentId = `caps-api-${crypto.randomUUID().slice(0, 8)}`;
    const put = await app.fetch(
      request(`/workspaces/${organizationId}/agent/spend-caps/${agentId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          maxRunsPerDay: 5,
          maxTokensPerDay: 100_000,
          maxCostMicrosPerRun: 500_000,
        }),
      }),
      env
    );
    expect(put.status).toBe(200);
    const caps = (await put.json()) as Record<string, unknown>;
    expect(caps.agentId).toBe(agentId);
    expect(caps.maxRunsPerDay).toBe(5);
    expect(caps.maxCostMicrosPerRun).toBe(500_000);

    const list = await app.fetch(
      request(`/workspaces/${organizationId}/agent/spend-caps`, { token }),
      env
    );
    const listed = (await list.json()) as { caps: Array<{ agentId: string }> };
    expect(listed.caps.some((row) => row.agentId === agentId)).toBe(true);

    // Explicit null clears a limit; omitted fields keep their value.
    const clear = await app.fetch(
      request(`/workspaces/${organizationId}/agent/spend-caps/${agentId}`, {
        method: "PUT",
        token,
        body: JSON.stringify({ maxTokensPerDay: null }),
      }),
      env
    );
    const cleared = (await clear.json()) as Record<string, unknown>;
    expect(cleared.maxTokensPerDay).toBeNull();
    expect(cleared.maxRunsPerDay).toBe(5);

    const del = await app.fetch(
      request(`/workspaces/${organizationId}/agent/spend-caps/${agentId}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(del.status).toBe(200);
    const delAgain = await app.fetch(
      request(`/workspaces/${organizationId}/agent/spend-caps/${agentId}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(delAgain.status).toBe(404);
  });

  it("records usage via /report and exposes the receipt", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const issue = await stub.createIssue({ title: "Receipt lane" });
    const reg = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({ issueId: issue.id, provider: "custom-bot" }),
      }),
      env
    );
    const { session, laneToken } = (await reg.json()) as {
      session: { id: string };
      laneToken: string;
    };
    const reportBase = `/workspaces/${organizationId}/agent/sessions/${session.id}/report`;

    const usageReport = await app.fetch(
      request(reportBase, {
        method: "POST",
        token: laneToken,
        body: JSON.stringify({
          status: "running",
          usage: {
            model: "claude-sonnet-4-5",
            inputTokens: 100_000,
            outputTokens: 10_000,
            toolCalls: 12,
            externalSpendMicros: 500,
          },
        }),
      }),
      env
    );
    expect(usageReport.status).toBe(200);

    // A malformed usage payload is rejected.
    const badUsage = await app.fetch(
      request(reportBase, {
        method: "POST",
        token: laneToken,
        body: JSON.stringify({ usage: { inputTokens: -1 } }),
      }),
      env
    );
    expect(badUsage.status).toBe(400);

    // Complete the run — the receipt finalizes with terminal status.
    await app.fetch(
      request(reportBase, {
        method: "POST",
        token: laneToken,
        body: JSON.stringify({ status: "completed", result: "done" }),
      }),
      env
    );

    const get = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    const detail = (await get.json()) as {
      receipt: {
        status: string;
        totalTokens: number;
        costMicros: number;
        costSource: string;
        toolCalls: number;
      } | null;
    };
    expect(detail.receipt).not.toBeNull();
    expect(detail.receipt?.status).toBe("completed");
    expect(detail.receipt?.totalTokens).toBe(110_000);
    expect(detail.receipt?.toolCalls).toBe(12);
    expect(detail.receipt?.costSource).toBe("rate_map");
    expect(detail.receipt?.costMicros).toBe(450_000);

    // List + summary endpoints expose the same record.
    const list = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/receipts?sessionId=${session.id}`,
        { token }
      ),
      env
    );
    const { receipts } = (await list.json()) as {
      receipts: Array<{ sessionId: string; totalCostMicros: number }>;
    };
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.totalCostMicros).toBe(450_500);

    const summary = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/receipts/summary?groupBy=agentId`,
        { token }
      ),
      env
    );
    const { summary: rows } = (await summary.json()) as {
      summary: Array<{ key: string; runs: number; totalTokens: number }>;
    };
    const row = rows.find((r) => r.key === "custom-bot");
    expect(row?.runs).toBe(1);
    expect(row?.totalTokens).toBe(110_000);
  });

});

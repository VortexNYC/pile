import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { drainDomainEvents } from "./pipeline-events.js";

const userId = "user-pipeline-events";
let organizationId = "";
let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Pipeline Events",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, headers, {
    name: "Pipeline events",
    slug: `pipeline-events-${crypto.randomUUID()}`,
    key: `PE${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  organizationId = workspace!.id;
  stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
});

describe("drainDomainEvents — issue.escalated (PILE-271)", () => {
  it("pages the external chief_of_staff and notifies the routed human — once per session", async () => {
    const endpoint = `https://chief.example.test/escalated-${crypto.randomUUID().slice(0, 8)}`;
    await stub.upsertAgentType({
      slug: "chief_of_staff",
      name: "Chief of Staff",
      providerAgentId: "flue",
      kind: "external",
      endpointUrl: endpoint,
    });
    const issue = await stub.createIssue({
      title: "dead lane escalation",
      assigneeId: userId,
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "devin-cli",
      provider: "devin-cli",
      actorId: userId,
      actorType: "user",
      status: "canceled",
    });
    // The DO mirrors the escalation session event into the domain-event
    // outbox (dedupe `escalated:{sessionId}`) — the drain picks it up.
    await stub.addAgentSessionEvent({
      sessionId: session.id,
      type: "issue.escalated",
      message: "run budget exhausted (10m) — escalated to triage",
      payload: {
        issueId: issue.id,
        reason: "max_duration",
        blockedOn: "run_budget",
        requiresHuman: true,
        key: `escalated-${session.id}`,
      },
    });
    const pending = (await stub.listPendingDomainEvents()).find(
      (e) => e.type === "issue.escalated"
    );
    expect(pending).toBeDefined();
    expect(pending?.dedupeKey).toBe(`escalated:${session.id}`);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const drained = await drainDomainEvents(env, stub, organizationId);
      expect(drained).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }

    // The manager-agent channel: one agent.escalated POST to the CoS
    // external endpoint carrying the dead lane's session + issue.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(endpoint);
    const body = JSON.parse(init.body as string) as {
      event: string;
      organizationId: string;
      session: { id: string } | null;
      issue: { id: string; identifier: string | null } | null;
      error: string | null;
    };
    expect(body.event).toBe("agent.escalated");
    expect(body.organizationId).toBe(organizationId);
    expect(body.session?.id).toBe(session.id);
    expect(body.issue?.id).toBe(issue.id);
    expect(body.issue?.identifier).toBe(issue.identifier);
    expect(body.error).toContain("max_duration");

    // The human fallback: the issue's assignee gets a lane_needs_input
    // notification — same routing as the stale-lane alert.
    const notifications = (await stub.listWorkspaceNotifications()).filter(
      (n) => n.issueId === issue.id && n.type === "lane_needs_input"
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.recipientId).toBe(userId);

    // Idempotent on redelivery: a crash between handling and the
    // `delivered` write leaves the row pending; the re-drain must not
    // re-page or re-notify.
    await runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.sql.exec(
        "UPDATE domain_events SET status = 'pending' WHERE id = ?",
        pending!.id
      );
    });
    const secondFetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", secondFetch);
    try {
      const redrained = await drainDomainEvents(env, stub, organizationId);
      expect(redrained).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(secondFetch).not.toHaveBeenCalled();
    const after = (await stub.listWorkspaceNotifications()).filter(
      (n) => n.issueId === issue.id && n.type === "lane_needs_input"
    );
    expect(after).toHaveLength(1);
  });

  it("notifies the lane's actor when the issue has no human assignee", async () => {
    const issue = await stub.createIssue({ title: "unassigned escalation" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "devin-cli",
      provider: "devin-cli",
      actorId: "agent-dispatcher-1",
      actorType: "agent",
      status: "failed",
    });
    await stub.addAgentSessionEvent({
      sessionId: session.id,
      type: "issue.escalated",
      message: "nudge budget exhausted — escalated to triage",
      payload: {
        issueId: issue.id,
        reason: "ci_failure",
        requiresHuman: true,
        key: `escalated-${session.id}`,
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await drainDomainEvents(env, stub, organizationId);
    } finally {
      vi.unstubAllGlobals();
    }

    const notifications = (await stub.listWorkspaceNotifications()).filter(
      (n) => n.issueId === issue.id && n.type === "lane_needs_input"
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.recipientId).toBe("agent-dispatcher-1");
    expect(notifications[0]?.recipientType).toBe("agent");
  });
});

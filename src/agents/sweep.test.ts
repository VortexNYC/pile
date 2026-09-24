import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { supportTickets, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import {
  DEFAULT_INACTIVITY_MINUTES,
  DEFAULT_TIMEOUT_MINUTES,
  hashAgentState,
  ingestFailedAgentSession,
  parseAgentTimeouts,
  progressIsStale,
} from "./sweep.js";

describe("parseAgentTimeouts", () => {
  it("returns defaults for missing or invalid config", () => {
    expect(parseAgentTimeouts(null)).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
    });
    expect(parseAgentTimeouts("not-json")).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
    });
  });

  it("reads timeout and inactivityTimeout", () => {
    expect(
      parseAgentTimeouts(JSON.stringify({ timeout: 90, inactivityTimeout: 10 }))
    ).toEqual({ timeoutMinutes: 90, inactivityMinutes: 10 });
  });
});

describe("progressIsStale", () => {
  const now = Date.parse("2026-09-16T16:00:00.000Z");

  it("uses createdAt when lastProgressAt is missing", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:30:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(true);
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:50:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });

  it("prefers lastProgressAt", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T12:00:00.000Z",
        lastProgressAt: "2026-09-16T15:50:00.000Z",
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });
});

describe("hashAgentState", () => {
  it("changes when provider payload changes", () => {
    expect(hashAgentState({ a: 1 })).not.toBe(hashAgentState({ a: 2 }));
  });
});

describe("ingestFailedAgentSession", () => {
  it("files a deduped support ticket for a failed provider session", async () => {
    const db = createD1(env.D1);
    const userId = "user-sweep-ingest";
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Sweep User",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Sweep ingest",
      slug: `sweep-${crypto.randomUUID()}`,
      key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    const organizationId = workspace!.id;

    const session = {
      id: "sess-fail-1",
      organizationId,
      issueId: "issue-1",
      agentId: "cursor-cli",
      provider: "cursor-cli",
      actorId: userId,
      actorType: "user" as const,
      status: "failed" as const,
      result: null,
      url: null,
      providerSessionId: "prov-1",
      prUrl: null,
      prState: null,
      branch: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastProgressAt: null,
      lastStateHash: null,
      retryOf: null,
      retryCount: 0,
      infraFailure: 0,
    };
    const polled = {
      id: "prov-1",
      agentId: "cursor-cli",
      status: "failed" as const,
      result:
        "Agent exited: Bearer abc123 secret leaked Authorization: Bearer tok",
      providerSessionId: "prov-1",
    };

    await ingestFailedAgentSession(env, organizationId, session, polled);
    const tickets = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.organizationId, organizationId));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.externalId).toBe("agent-session-sess-fail-1");
    expect(tickets[0]!.title).toContain("cursor-cli");

    // Idempotent: same session failure must not open a second ticket.
    await ingestFailedAgentSession(env, organizationId, session, polled);
    const after = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.organizationId, organizationId));
    expect(after).toHaveLength(1);
  });
});

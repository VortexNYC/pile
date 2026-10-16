import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createD1, type D1Client } from "../global/db.js";
import {
  supportTicketEvents,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
import { updateTicket } from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import type { AgentSession } from "../types/workspace.js";
import {
  AGENT_FAILURE_TICKET_CAP,
  AGENT_FAILURE_TICKET_WINDOW_MS,
  agentFailureKeyPrefix,
  agentFailureRollupKey,
  failureProviderToken,
  failureSignatureHash,
  failureSummary,
  ingestFailedAgentSession,
  normalizeFailureSignature,
} from "./failure-tickets.js";
import type { AgentProviderSession } from "./provider.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

describe("normalizeFailureSignature", () => {
  it("collapses volatile ids, numbers, and whitespace", () => {
    const a = normalizeFailureSignature(
      "Runner 8f1c2a3b-44dd-4e55-9a01-112233445566 died at 2026-10-15T03:00:00Z, exit 137"
    );
    const b = normalizeFailureSignature(
      "Runner 00112233-9999-4abc-8def-667788990011 died at 2026-10-15T05:30:00Z, exit 137"
    );
    expect(a).toBe(b);
    expect(a).not.toContain("8f1c2a3b");
  });

  it("distinguishes different errors", () => {
    expect(normalizeFailureSignature("out of memory")).not.toBe(
      normalizeFailureSignature("runner never started")
    );
  });

  it("scrubs secrets before hashing material is produced", () => {
    const sig = normalizeFailureSignature("boom Bearer secrettoken123");
    expect(sig).not.toContain("secrettoken123");
    expect(sig).toContain("[redacted]");
  });
});

describe("failureSignatureHash", () => {
  it("is deterministic and short", async () => {
    const sig = normalizeFailureSignature("runner never started");
    const hash = await failureSignatureHash(sig);
    expect(hash).toHaveLength(12);
    expect(hash).toBe(await failureSignatureHash(sig));
    expect(await failureSignatureHash("")).toBe("no-detail");
  });
});

describe("failureProviderToken", () => {
  it("sanitizes to a LIKE-safe token", () => {
    expect(failureProviderToken("Devin CLI")).toBe("devin-cli");
    expect(failureProviderToken("weird%_provider")).toBe("weird-provider");
    expect(failureProviderToken("!!!")).toBe("unknown");
  });
});

describe("failureSummary", () => {
  it("returns the first scrubbed line", () => {
    expect(failureSummary("\n\nrunner never started\nmore detail")).toBe(
      "runner never started"
    );
    expect(failureSummary(null)).toBe(
      "provider reported failure with no details"
    );
  });
});

describe("failure dedupe keys", () => {
  it("keys on provider + window + signature hash", () => {
    const prefix = agentFailureKeyPrefix("devin-cli", NOW);
    expect(prefix).toBe(
      `agent-failure:devin-cli:w${Math.floor(NOW / AGENT_FAILURE_TICKET_WINDOW_MS)}`
    );
    // Next window gets a different prefix.
    expect(
      agentFailureKeyPrefix("devin-cli", NOW + AGENT_FAILURE_TICKET_WINDOW_MS)
    ).not.toBe(prefix);
    // Rollup key shares the window but not the signature-ticket LIKE prefix.
    expect(agentFailureRollupKey("devin-cli", NOW)).toBe(
      `agent-failure-rollup:devin-cli:w${Math.floor(NOW / AGENT_FAILURE_TICKET_WINDOW_MS)}`
    );
    expect(agentFailureRollupKey("devin-cli", NOW)).not.toMatch(
      /^agent-failure:/
    );
  });
});

async function makeWorkspace(tag: string) {
  const db = createD1(env.D1);
  const userId = `user-ingest-${tag}`;
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Ingest User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, headers, {
    name: `Ingest ${tag}`,
    slug: `ingest-${crypto.randomUUID()}`,
    key: `I${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  return { db, organizationId: workspace!.id, userId };
}

function failedSession(
  organizationId: string,
  userId: string,
  id: string,
  provider = "cursor-cli"
): AgentSession {
  const ts = new Date(NOW).toISOString();
  return {
    id,
    organizationId,
    issueId: "issue-1",
    agentId: provider,
    provider,
    actorId: userId,
    actorType: "user",
    status: "failed",
    result: null,
    url: null,
    providerSessionId: `prov-${id}`,
    prUrl: null,
    prState: null,
    branch: null,
    createdAt: ts,
    updatedAt: ts,
    lastProgressAt: null,
    lastStateHash: null,
    retryOf: null,
    retryCount: 0,
    infraFailure: 0,
    startedAt: null,
    queuedAfter: null,
    parentSessionId: null,
    spawnDepth: 0,
    laneDbRef: null,
    purpose: null,
    endedAt: null,
    secondaryRepos: null,
    maxDurationMinutes: null,
    effort: null,
    label: null,
    resultSchema: null,
    structuredResult: null,
    resultSchemaErrors: null,
    lastReviewedSha: null,
    reviewSummary: null,
    sandboxBackupRef: null,
    awaitingActivityId: null,
    awaitingEscalatedAt: null,
    paused: 0,
    guidance: null,
    stepKey: null,
    plan: null,
  };
}

function failure(result: string, id = "prov-1"): AgentProviderSession {
  return {
    id,
    agentId: "cursor-cli",
    status: "failed",
    result,
    providerSessionId: id,
  };
}

async function ticketsFor(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.organizationId, organizationId));
}

async function messageCount(db: D1Client, ticketId: string) {
  const events = await db
    .select()
    .from(supportTicketEvents)
    .where(eq(supportTicketEvents.ticketId, ticketId));
  return events.filter((e) => e.type === "message").length;
}

describe("ingestFailedAgentSession", () => {
  it("files a deduped support ticket carrying the error summary", async () => {
    const { db, organizationId, userId } = await makeWorkspace("dedupe");
    const session = failedSession(organizationId, userId, "sess-fail-1");
    const polled = failure(
      "Agent exited: Bearer abc123 secret leaked Authorization: Bearer tok"
    );

    await ingestFailedAgentSession(env, organizationId, session, polled, NOW);
    const tickets = await ticketsFor(db, organizationId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.externalId).toMatch(
      /^agent-failure:cursor-cli:w\d+:[0-9a-f]{12}$/
    );
    expect(tickets[0]!.title).toContain("cursor-cli");
    expect(tickets[0]!.title).toContain("Agent exited");

    // Idempotent: same session failure must not open a second ticket or a
    // second message.
    await ingestFailedAgentSession(env, organizationId, session, polled, NOW);
    expect(await ticketsFor(db, organizationId)).toHaveLength(1);
    expect(await messageCount(db, tickets[0]!.id)).toBe(1);
  });

  it("appends repeat failures to the same ticket instead of new tickets", async () => {
    const { db, organizationId, userId } = await makeWorkspace("repeat");
    const result =
      "runner never started for session 8f1c2a3b-44dd-4e55-9a01-112233445566";

    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-a"),
      failure(result, "prov-a"),
      NOW
    );
    // Same signature, different session + different embedded uuid.
    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-b"),
      failure(
        "runner never started for session 00112233-9999-4abc-8def-667788990011",
        "prov-b"
      ),
      NOW
    );

    const tickets = await ticketsFor(db, organizationId);
    expect(tickets).toHaveLength(1);
    expect(await messageCount(db, tickets[0]!.id)).toBe(2);
  });

  it("creates a new ticket for a different signature in the same window", async () => {
    const { db, organizationId, userId } = await makeWorkspace("distinct");
    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-a"),
      failure("runner never started"),
      NOW
    );
    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-b"),
      failure("sandbox OOM killed"),
      NOW
    );
    expect(await ticketsFor(db, organizationId)).toHaveLength(2);
  });

  it("opens a fresh ticket for the same signature in the next window", async () => {
    const { db, organizationId, userId } = await makeWorkspace("window");
    const session = failedSession(organizationId, userId, "sess-a");
    await ingestFailedAgentSession(
      env,
      organizationId,
      session,
      failure("runner never started"),
      NOW
    );
    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-b"),
      failure("runner never started"),
      NOW + AGENT_FAILURE_TICKET_WINDOW_MS
    );
    expect(await ticketsFor(db, organizationId)).toHaveLength(2);
  });

  it("caps per-provider tickets per window and rolls overflow into a summary ticket", async () => {
    const { db, organizationId, userId } = await makeWorkspace("cap");
    const errors = [
      "runner never started",
      "sandbox OOM killed",
      "image pull back-off",
      "provider 5xx on attach",
      "quota exhausted mid-run",
      "tls handshake reset",
      "runner exited code 1",
    ];
    for (let i = 0; i < AGENT_FAILURE_TICKET_CAP + 2; i++) {
      await ingestFailedAgentSession(
        env,
        organizationId,
        failedSession(organizationId, userId, `sess-cap-${i}`),
        failure(errors[i]!),
        NOW
      );
    }

    const tickets = await ticketsFor(db, organizationId);
    expect(tickets).toHaveLength(AGENT_FAILURE_TICKET_CAP + 1);
    const rollup = tickets.filter(
      (t) => t.externalId === agentFailureRollupKey("cursor-cli", NOW)
    );
    expect(rollup).toHaveLength(1);
    expect(rollup[0]!.title).toContain("distinct errors");
    expect(rollup[0]!.priority).toBe("high");
    // Both overflow failures landed on the rollup ticket.
    expect(await messageCount(db, rollup[0]!.id)).toBe(2);
  });

  it("reopens a resolved ticket when the same failure recurs", async () => {
    const { db, organizationId, userId } = await makeWorkspace("reopen");
    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-a"),
      failure("runner never started"),
      NOW
    );
    const [ticket] = await ticketsFor(db, organizationId);
    await updateTicket(
      db,
      organizationId,
      ticket!.id,
      { status: "done", actorType: "user", actorId: userId },
      env
    );

    await ingestFailedAgentSession(
      env,
      organizationId,
      failedSession(organizationId, userId, "sess-b"),
      failure("runner never started"),
      NOW
    );

    const tickets = await ticketsFor(db, organizationId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.status).toBe("todo");
    expect(await messageCount(db, tickets[0]!.id)).toBe(2);
  });
});

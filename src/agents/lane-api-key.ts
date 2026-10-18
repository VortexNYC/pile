// PILE-442 — per-session Pile API keys for dispatched lanes.
//
// The key a lane receives as PILE_API_KEY is scoped to the agent type's
// declared role: `permissionsTier` names a bundle and `toolScope` widens it
// per domain ("write:pile-customers" → customer:create/edit). The key is
// minted under the agent's identity (the audit trail shows "scout minted
// this token", not a human operator), expires within a day as a hard bound,
// and is bound to the session in DO storage so the sweep revokes whatever
// the lane still holds once the run goes terminal — same lifecycle as the
// lane's GitHub installation token.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { apikey, teamMember, user as userTable } from "../global/schema.js";
import { addTeamMember } from "../global/teams.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

/**
 * Named permission bundles for agent_type.permissionsTier. Every tier
 * includes workspace "read" so lanes can always fetch context; unknown or
 * absent tiers fail closed to read-only — a typo never widens a lane's
 * reach, it just reverts to the pre-PILE-442 posture.
 */
export const LANE_API_TIERS: Record<string, readonly string[]> = {
  read: ["read"],
  readonly: ["read"],
  // Pipeline research/write-back roles (scout, profiler, detective,
  // ranker): findings land on issues/comments, documents, and the customer
  // records the step works — nothing else.
  research: [
    "read",
    "issue:view",
    "issue:create",
    "issue:edit",
    "comment:view",
    "comment:create",
    "document:view",
    "document:create",
    "document:edit",
    "customer:view",
    "customer:create",
    "customer:edit",
    "contact:view",
    "deal:view",
    "ticket:view",
  ],
  // Member-parity write access and the break-glass tier.
  write: ["read", "write"],
  admin: ["admin"],
};

/**
 * agent_type.toolScope entries are "<verb>:<domain>" — a declared surface
 * the role operates in. Each expands into the resource:action grants that
 * surface needs over the API. "web" maps to nothing server-side (outbound
 * fetch is governed by the lane tool policy, not API permissions).
 * Unrecognized entries are ignored — fail closed.
 */
const TOOL_SCOPE_GRANTS: Record<string, readonly string[]> = {
  "read:web": [],
  "write:web": [],
  "read:pile": ["read"],
  "write:pile": ["read", "write"],
  "read:pile-issues": ["issue:view", "comment:view"],
  "write:pile-issues": [
    "issue:view",
    "issue:create",
    "issue:edit",
    "comment:view",
    "comment:create",
  ],
  "read:pile-documents": ["document:view"],
  "write:pile-documents": ["document:view", "document:create", "document:edit"],
  "read:pile-customers": ["customer:view"],
  "write:pile-customers": ["customer:view", "customer:create", "customer:edit"],
  "read:pile-deals": ["deal:view"],
  "write:pile-deals": ["deal:view", "deal:create", "deal:edit"],
  "read:pile-contacts": ["contact:view"],
  "write:pile-contacts": ["contact:view", "contact:create", "contact:edit"],
  "read:pile-tickets": ["ticket:view"],
  "write:pile-tickets": ["ticket:view", "ticket:create", "ticket:edit"],
};

/** Resolve the workspace permission list a lane's key carries. */
export function laneApiPermissions(input: {
  permissionsTier?: string | null;
  toolScope?: string | null;
}): string[] {
  const tier = input.permissionsTier?.trim().toLowerCase();
  const grants = new Set<string>(
    (tier && LANE_API_TIERS[tier]) || LANE_API_TIERS.read
  );
  for (const entry of (input.toolScope ?? "").split(",")) {
    const scope = entry.trim().toLowerCase();
    if (!scope) continue;
    for (const grant of TOOL_SCOPE_GRANTS[scope] ?? []) grants.add(grant);
  }
  return [...grants];
}

// The apiKey plugin's default keyExpiration floor is 1 day — the smallest
// TTL it accepts. Terminal revocation by the sweep is the real bound; the
// TTL is the backstop for lanes whose reaper never runs.
export const LANE_API_KEY_TTL_SECONDS = 24 * 60 * 60;

interface LaneKeyRecord {
  keyId: string;
  /** Agent slug/provider id the key was minted under — audit attribution. */
  agent: string;
}

/**
 * Mint the lane's scoped credential and bind it to the session for
 * terminal revocation. Returns null when PUBLIC_API_URL isn't configured
 * (the deploy lacks a public origin — dispatch proceeds without Pile API
 * access, same as before).
 */
export async function mintLaneApiKey(
  env: WorkerEnv,
  stub: WorkspaceStub,
  args: {
    organizationId: string;
    sessionId: string;
    /** The lane's identity: the agent-type slug ("scout") when profiled,
     *  else the provider id. Keys verify as this actor, so writes the lane
     *  makes attribute to the role rather than the dispatching user. */
    agent: string;
    permissionsTier?: string | null;
    toolScope?: string | null;
    /** Team of the issue being worked — the agent identity joins it so the
     *  lane can read/comment its own issue (agent keys see only teams
     *  they're installed on). */
    teamId?: string | null;
  }
): Promise<{ url: string; key: string; permissions: string[] } | null> {
  if (!env.PUBLIC_API_URL) return null;
  const permissions = laneApiPermissions(args);
  const db = createD1(env.D1);
  // The key verifies as the role itself — a synthetic user row keyed on the
  // slug ("scout") so the lane's writes attribute to the agent identity and
  // the team install below has a real user to point at (team_member.user_id
  // references user.id).
  const agentUser = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.id, args.agent))
    .get();
  if (!agentUser) {
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: args.agent,
        name: args.agent,
        email: `agent-${args.agent}@${args.organizationId}.pile.nyc`,
        emailVerified: true,
        metadata: JSON.stringify({ type: "agent", agent: args.agent }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: userTable.email });
  }
  const auth = await createAuth(env);
  const created = await auth.api.createApiKey({
    body: {
      userId: args.agent,
      name: `agent-${args.sessionId.slice(0, 13)}`,
      rateLimitEnabled: false,
      expiresIn: LANE_API_KEY_TTL_SECONDS,
      metadata: {
        organizationId: args.organizationId,
        permissions: permissions.join(","),
        actorType: "agent",
        sessionId: args.sessionId,
        agent: args.agent,
      },
      permissions: { workspace: permissions },
    },
  });
  const parsed = z
    .object({ id: z.string(), key: z.string() })
    .safeParse(created);
  if (!parsed.success) {
    throw new Error("unexpected createApiKey response shape");
  }
  const record: LaneKeyRecord = { keyId: parsed.data.id, agent: args.agent };
  await stub.setLaneApiKey(args.sessionId, JSON.stringify(record));
  if (args.teamId) {
    const existing = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, args.teamId),
          eq(teamMember.userId, args.agent)
        )
      )
      .get();
    if (!existing) {
      // Install the role identity on the issue's team — same shape as the
      // tokens route's agent-key team grants.
      await addTeamMember(
        db,
        env,
        new Headers(),
        args.organizationId,
        args.teamId,
        parsed.data.id,
        "agent"
      );
    }
  }
  await stub
    .recordAudit(
      "token.created",
      "token",
      parsed.data.id,
      args.agent,
      {
        name: { from: null, to: `agent-${args.sessionId.slice(0, 13)}` },
        permissions: { from: null, to: permissions.join(",") },
        session: { from: null, to: args.sessionId },
      },
      { actorType: "agent" }
    )
    .catch(() => {
      // Audit failure must not break dispatch.
    });
  return { url: env.PUBLIC_API_URL, key: parsed.data.key, permissions };
}

/** Revoke the lane keys of every session that's terminal (or gone). */
export async function reapLaneApiKeys(
  env: WorkerEnv,
  stub: WorkspaceStub
): Promise<number> {
  const db = createD1(env.D1);
  let revoked = 0;
  for (const sessionId of await stub.listLaneApiKeySessions()) {
    const session = await stub.getAgentSession(sessionId);
    if (session && !TERMINAL_STATUSES.has(session.status)) continue;
    const raw = await stub.takeLaneApiKey(sessionId);
    if (!raw) continue;
    let record: Partial<LaneKeyRecord> = {};
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "object" && value !== null) {
        record = value as Partial<LaneKeyRecord>;
      }
    } catch {
      // Malformed slot — drop it below via the take() already done.
    }
    const keyId = typeof record.keyId === "string" ? record.keyId : null;
    if (keyId) {
      await db.delete(apikey).where(eq(apikey.id, keyId));
      revoked++;
    }
    await stub
      .recordAudit(
        "token.revoked",
        "token",
        keyId ?? sessionId,
        typeof record.agent === "string" ? record.agent : null,
        { session: { from: sessionId, to: null } },
        { actorType: "agent" }
      )
      .catch(() => {
        // Audit failure must not break the reaper.
      });
  }
  return revoked;
}

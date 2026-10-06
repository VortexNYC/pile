import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { invitation, team, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `invite-user-${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Invite User",
      email,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Invitations test",
    slug: `invite-${crypto.randomUUID()}`,
    key: `I${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  if (!workspace) throw new Error("workspace not created");

  const auth = await createAuth(env);
  const adminResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      metadata: { organizationId: workspace.id, permissions: "admin" },
    },
  });
  const adminParsed = z.object({ key: z.string() }).parse(adminResult);

  const readResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-read",
      metadata: { organizationId: workspace.id, permissions: "read" },
    },
  });
  const readParsed = z.object({ key: z.string() }).parse(readResult);

  const defaultTeam = await db
    .select({ id: team.id })
    .from(team)
    .where(eq(team.organizationId, workspace.id))
    .get();

  return {
    organizationId: workspace.id,
    ownerId: userId,
    ownerEmail: email,
    defaultTeamId: defaultTeam?.id,
    adminToken: adminParsed.key,
    readToken: readParsed.key,
  };
}

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env);
}

async function invite(
  organizationId: string,
  token: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(
    `/workspaces/${organizationId}/invitations`,
    { method: "POST", body: JSON.stringify(body) },
    token
  );
}

async function listInvitations(
  organizationId: string,
  token: string,
  query = ""
): Promise<Response> {
  return fetch(`/workspaces/${organizationId}/invitations${query}`, {}, token);
}

async function seedOwnerSession() {
  const db = createD1(env.D1);
  const auth = await createAuth(env);
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const password = "password12345";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: "Invite Owner" },
  });
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(signUp)
    .user.id;
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signInRes.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="));
  const cookie = rawCookie?.split(";")[0];
  if (!cookie) throw new Error("No session cookie");

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Owner invite test",
    slug: `owner-${crypto.randomUUID()}`,
    key: `O${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  if (!workspace) throw new Error("workspace not created");
  return { cookie, organizationId: workspace.id };
}

const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  teamId: z.string().nullable(),
  expiresAt: z.number().int(),
  inviterId: z.string(),
  createdAt: z.number().int(),
});

describe("workspace invitations API", () => {
  let organizationId: string;
  let ownerId: string;
  let ownerEmail: string;
  let defaultTeamId: string | undefined;
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    ownerId = seeded.ownerId;
    ownerEmail = seeded.ownerEmail;
    defaultTeamId = seeded.defaultTeamId;
    adminToken = seeded.adminToken;
    readToken = seeded.readToken;
  });

  it("rejects creating an invitation without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/invitations`, {
      method: "POST",
      headers: { Origin: "https://pile.example.workers.dev" },
      body: JSON.stringify({ email: "a@example.com", role: "member" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects creating an invitation with a read-only token", async () => {
    const res = await invite(organizationId, readToken, {
      email: "a@example.com",
      role: "member",
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid role", async () => {
    const res = await invite(organizationId, adminToken, {
      email: "a@example.com",
      role: "superadmin",
    });
    expect(res.status).toBe(400);
  });

  it("creates a pending invitation", async () => {
    const email = `inv-${crypto.randomUUID()}@example.com`;
    const res = await invite(organizationId, adminToken, {
      email,
      role: "member",
    });
    expect(res.status).toBe(201);
    const body = invitationSchema.parse(await res.json());
    expect(body.email).toBe(email.toLowerCase());
    expect(body.role).toBe("member");
    expect(body.status).toBe("pending");
    expect(body.organizationId).toBe(organizationId);
    expect(body.inviterId).toBe(ownerId);
  });

  it("creates an invitation bound to a team", async () => {
    expect(defaultTeamId).toBeDefined();
    const res = await invite(organizationId, adminToken, {
      email: `team-${crypto.randomUUID()}@example.com`,
      role: "member",
      teamId: defaultTeamId,
    });
    expect(res.status).toBe(201);
    const body = invitationSchema.parse(await res.json());
    expect(body.teamId).toBe(defaultTeamId);
  });

  it("rejects a team from another org", async () => {
    const res = await invite(organizationId, adminToken, {
      email: `badteam-${crypto.randomUUID()}@example.com`,
      role: "member",
      teamId: "team-does-not-exist",
    });
    expect(res.status).toBe(400);
  });

  it("rejects inviting an existing member", async () => {
    const res = await invite(organizationId, adminToken, {
      email: ownerEmail,
      role: "member",
    });
    expect(res.status).toBe(400);
  });

  it("rejects owner-role invitations from API tokens", async () => {
    // The admin token's better-auth session resolves to the workspace
    // owner — the product layer must still refuse role escalation.
    const res = await invite(organizationId, adminToken, {
      email: `owner-invite-${crypto.randomUUID()}@example.com`,
      role: "owner",
    });
    expect(res.status).toBe(403);
  });

  it("allows a signed-in owner to invite an owner", async () => {
    const { cookie, organizationId: ownerOrg } = await seedOwnerSession();
    const res = await fetch(`/workspaces/${ownerOrg}/invitations`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://pile.example.workers.dev",
      },
      body: JSON.stringify({
        email: `co-owner-${crypto.randomUUID()}@example.com`,
        role: "owner",
      }),
    });
    expect(res.status).toBe(201);
    const body = invitationSchema.parse(await res.json());
    expect(body.role).toBe("owner");
  });

  it("rejects a duplicate pending invitation", async () => {
    const email = `dup-${crypto.randomUUID()}@example.com`;
    const first = await invite(organizationId, adminToken, {
      email,
      role: "member",
    });
    expect(first.status).toBe(201);
    const second = await invite(organizationId, adminToken, {
      email,
      role: "member",
    });
    expect(second.status).toBe(400);
  });

  it("lists pending invitations by default", async () => {
    const email = `list-${crypto.randomUUID()}@example.com`;
    const created = await invite(organizationId, adminToken, {
      email,
      role: "admin",
    });
    expect(created.status).toBe(201);
    const createdBody = invitationSchema.parse(await created.json());

    const res = await listInvitations(organizationId, adminToken);
    expect(res.status).toBe(200);
    const body = z
      .object({ invitations: z.array(invitationSchema) })
      .parse(await res.json());
    const found = body.invitations.find((i) => i.id === createdBody.id);
    expect(found?.email).toBe(email.toLowerCase());
    expect(body.invitations.every((i) => i.status === "pending")).toBe(true);
  });

  it("excludes expired invitations from the pending list", async () => {
    const db = createD1(env.D1);
    const expiredId = `inv-expired-${crypto.randomUUID()}`;
    await db.insert(invitation).values({
      id: expiredId,
      organizationId,
      email: `expired-${crypto.randomUUID()}@example.com`,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      inviterId: ownerId,
      createdAt: new Date(),
    });

    const pending = await listInvitations(organizationId, adminToken);
    const pendingBody = z
      .object({ invitations: z.array(invitationSchema) })
      .parse(await pending.json());
    expect(pendingBody.invitations.some((i) => i.id === expiredId)).toBe(false);

    const all = await listInvitations(
      organizationId,
      adminToken,
      "?status=all"
    );
    const allBody = z
      .object({ invitations: z.array(invitationSchema) })
      .parse(await all.json());
    expect(allBody.invitations.some((i) => i.id === expiredId)).toBe(true);
  });

  it("rejects listing invitations with a read-only token", async () => {
    const res = await listInvitations(organizationId, readToken);
    expect(res.status).toBe(403);
  });

  it("cancels a pending invitation", async () => {
    const email = `cancel-${crypto.randomUUID()}@example.com`;
    const created = await invite(organizationId, adminToken, {
      email,
      role: "member",
    });
    const createdBody = invitationSchema.parse(await created.json());

    const res = await fetch(
      `/workspaces/${organizationId}/invitations/${createdBody.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(res.status).toBe(204);

    const row = await createD1(env.D1)
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, createdBody.id))
      .get();
    expect(row?.status).toBe("canceled");

    const list = await listInvitations(
      organizationId,
      adminToken,
      "?status=canceled"
    );
    const body = z
      .object({ invitations: z.array(invitationSchema) })
      .parse(await list.json());
    expect(body.invitations.some((i) => i.id === createdBody.id)).toBe(true);
  });

  it("returns 404 canceling an unknown invitation", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/invitations/inv-missing`,
      { method: "DELETE" },
      adminToken
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 canceling an invitation that is not pending", async () => {
    const created = await invite(organizationId, adminToken, {
      email: `twice-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    const createdBody = invitationSchema.parse(await created.json());
    const first = await fetch(
      `/workspaces/${organizationId}/invitations/${createdBody.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(first.status).toBe(204);
    const second = await fetch(
      `/workspaces/${organizationId}/invitations/${createdBody.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(second.status).toBe(409);
  });

  it("cannot cancel another workspace's invitation", async () => {
    const other = await seedWorkspace();
    const created = await invite(other.organizationId, other.adminToken, {
      email: `foreign-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    const createdBody = invitationSchema.parse(await created.json());

    const res = await fetch(
      `/workspaces/${organizationId}/invitations/${createdBody.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(res.status).toBe(404);

    const row = await createD1(env.D1)
      .select({ status: invitation.status })
      .from(invitation)
      .where(
        and(
          eq(invitation.id, createdBody.id),
          eq(invitation.organizationId, other.organizationId)
        )
      )
      .get();
    expect(row?.status).toBe("pending");
  });

  it("resends a pending invitation", async () => {
    const created = await invite(organizationId, adminToken, {
      email: `resend-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    const createdBody = invitationSchema.parse(await created.json());

    const res = await fetch(
      `/workspaces/${organizationId}/invitations/${createdBody.id}/resend`,
      { method: "POST" },
      adminToken
    );
    expect(res.status).toBe(200);
    const body = invitationSchema.parse(await res.json());
    expect(body.status).toBe("pending");
  });
});

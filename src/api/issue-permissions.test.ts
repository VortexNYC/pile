import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  member as memberTable,
  team as teamTable,
  user as userTable,
} from "../global/schema.js";
import { parseTeamMetadata } from "../global/team-metadata.js";
import { addTeamMember, createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ADMIN_ID = "user-issue-perms-admin";
const MEMBER_ID = "user-issue-perms-member";
const OTHER_ID = "user-issue-perms-other";

interface Seeded {
  organizationId: string;
  teamId: string;
  adminToken: string;
  memberToken: string;
  otherToken: string;
}

async function createKey(userId: string, organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: `test-${userId}`,
      rateLimitEnabled: false,
      metadata: {
        organizationId,
        permissions: userId === ADMIN_ID ? "admin" : "read,write",
      },
    },
  });
  return z.object({ key: z.string() }).parse(result).key;
}

async function seedWorkspace(): Promise<Seeded> {
  const db = createD1(env.D1);
  const now = new Date();
  for (const id of [ADMIN_ID, MEMBER_ID, OTHER_ID]) {
    await db
      .insert(userTable)
      .values({
        id,
        name: `Perms ${id}`,
        email: `${id}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.id] });
  }

  const setupHeaders = await createAdminHeaders(env, ADMIN_ID);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Issue perms test",
    slug: `issue-perms-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: ADMIN_ID,
  });
  const organizationId = workspace!.id;

  // Org member rows (assignee resolution + membership checks).
  for (const userId of [MEMBER_ID, OTHER_ID]) {
    await db.insert(memberTable).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "member",
      createdAt: now,
    });
  }

  const teams = await db
    .select()
    .from(teamTable)
    .where(eq(teamTable.organizationId, organizationId))
    .all();
  const defaultTeam = teams.find(
    (row) => parseTeamMetadata(row.metadata)?.isDefault
  );
  if (!defaultTeam) throw new Error("default team missing");

  // Both non-admin members can see issues on the default team — issue grants
  // are the only differentiator under test.
  for (const userId of [MEMBER_ID, OTHER_ID]) {
    await addTeamMember(
      db,
      env,
      setupHeaders,
      organizationId,
      defaultTeam.id,
      userId,
      "user"
    );
  }

  return {
    organizationId,
    teamId: defaultTeam.id,
    adminToken: await createKey(ADMIN_ID, organizationId),
    memberToken: await createKey(MEMBER_ID, organizationId),
    otherToken: await createKey(OTHER_ID, organizationId),
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
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

async function createIssue(
  organizationId: string,
  token: string,
  input: Record<string, unknown>
): Promise<{ id: string; identifier: string; teamId: string }> {
  const res = await fetch(
    `/workspaces/${organizationId}/issues`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    token
  );
  expect(res.status).toBe(201);
  return res.json();
}

async function grant(
  seeded: Seeded,
  issueId: string,
  actorId: string,
  actorType?: string
) {
  const res = await fetch(
    `/workspaces/${seeded.organizationId}/issues/${issueId}/permissions`,
    {
      method: "PUT",
      body: JSON.stringify(actorType ? { actorId, actorType } : { actorId }),
    },
    seeded.adminToken
  );
  expect(res.status).toBe(200);
  return res.json<{ actorId: string }>();
}

async function revoke(seeded: Seeded, issueId: string, actorId: string) {
  return fetch(
    `/workspaces/${seeded.organizationId}/issues/${issueId}/permissions/${actorId}`,
    { method: "DELETE" },
    seeded.adminToken
  );
}

const issueIds = (body: { issues: Array<{ id: string }> }) =>
  body.issues.map((issue) => issue.id);

describe("issue permissions", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedWorkspace();
  });

  it("defaults issues open and restricts them once a grant exists", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Comp review for rep",
      teamId: seeded.teamId,
    });
    const base = `/workspaces/${seeded.organizationId}/issues/${issue.id}`;

    // No grants — every workspace member sees it.
    expect((await fetch(base, {}, seeded.memberToken)).status).toBe(200);
    expect((await fetch(base, {}, seeded.otherToken)).status).toBe(200);

    // First grant restricts the issue to listed actors + admins.
    await grant(seeded, issue.id, MEMBER_ID);
    expect((await fetch(base, {}, seeded.memberToken)).status).toBe(200);
    expect((await fetch(base, {}, seeded.otherToken)).status).toBe(404);
    // Admins bypass.
    expect((await fetch(base, {}, seeded.adminToken)).status).toBe(200);

    const list = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/issues/${issue.id}/permissions`,
        {},
        seeded.adminToken
      )
    ).json<{ permissions: Array<{ actorId: string }> }>();
    expect(list.permissions).toHaveLength(1);
    expect(list.permissions[0].actorId).toBe(MEMBER_ID);
  });

  it("hides restricted issues from list for ungranted members", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Sensitive personnel matter",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, MEMBER_ID);

    const memberList = issueIds(
      await (
        await fetch(
          `/workspaces/${seeded.organizationId}/issues`,
          {},
          seeded.memberToken
        )
      ).json<{ issues: Array<{ id: string }> }>()
    );
    const otherList = issueIds(
      await (
        await fetch(
          `/workspaces/${seeded.organizationId}/issues`,
          {},
          seeded.otherToken
        )
      ).json<{ issues: Array<{ id: string }> }>()
    );
    const adminList = issueIds(
      await (
        await fetch(
          `/workspaces/${seeded.organizationId}/issues`,
          {},
          seeded.adminToken
        )
      ).json<{ issues: Array<{ id: string }> }>()
    );

    expect(memberList).toContain(issue.id);
    expect(otherList).not.toContain(issue.id);
    expect(adminList).toContain(issue.id);
  });

  it("reopens the issue when the final grant is revoked", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Temporary restriction",
      teamId: seeded.teamId,
    });
    const base = `/workspaces/${seeded.organizationId}/issues/${issue.id}`;
    await grant(seeded, issue.id, ADMIN_ID);
    expect((await fetch(base, {}, seeded.otherToken)).status).toBe(404);

    const res = await revoke(seeded, issue.id, ADMIN_ID);
    expect(res.status).toBe(204);
    expect((await fetch(base, {}, seeded.otherToken)).status).toBe(200);
  });

  it("covers all members of a granted team", async () => {
    const db = createD1(env.D1);
    const setupHeaders = await createAdminHeaders(env, ADMIN_ID);
    const team = await createTeam(db, env, setupHeaders, {
      organizationId: seeded.organizationId,
      key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      name: "Leadership",
      ownerId: ADMIN_ID,
      isDefault: false,
      isPublic: false,
    });
    await addTeamMember(
      db,
      env,
      setupHeaders,
      seeded.organizationId,
      team.id,
      MEMBER_ID,
      "user"
    );

    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Leadership-only issue",
      teamId: seeded.teamId,
    });
    const base = `/workspaces/${seeded.organizationId}/issues/${issue.id}`;
    await grant(seeded, issue.id, team.id, "team");

    expect((await fetch(base, {}, seeded.memberToken)).status).toBe(200);
    expect((await fetch(base, {}, seeded.otherToken)).status).toBe(404);
  });

  it("filters restricted issues from search results", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Unfindable zucchini matter",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, ADMIN_ID);

    const search = async (token: string) =>
      (
        await (
          await fetch(
            `/workspaces/${seeded.organizationId}/search`,
            {
              method: "POST",
              body: JSON.stringify({ query: "zucchini" }),
            },
            token
          )
        ).json<{ issueIds: string[] }>()
      ).issueIds;

    expect(await search(seeded.otherToken)).not.toContain(issue.id);
    expect(await search(seeded.memberToken)).not.toContain(issue.id);
    expect(await search(seeded.adminToken)).toContain(issue.id);
  });

  it("filters restricted children from the children list", async () => {
    const parent = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Parent issue",
      teamId: seeded.teamId,
    });
    const openChild = await createIssue(
      seeded.organizationId,
      seeded.adminToken,
      { title: "Open child", teamId: seeded.teamId, parentId: parent.id }
    );
    const secretChild = await createIssue(
      seeded.organizationId,
      seeded.adminToken,
      { title: "Secret child", teamId: seeded.teamId, parentId: parent.id }
    );
    await grant(seeded, secretChild.id, ADMIN_ID);

    const children = issueIds(
      await (
        await fetch(
          `/workspaces/${seeded.organizationId}/issues/${parent.id}/children`,
          {},
          seeded.otherToken
        )
      ).json<{ issues: Array<{ id: string }> }>()
    );
    expect(children).toContain(openChild.id);
    expect(children).not.toContain(secretChild.id);
  });

  it("blocks subresources of a restricted issue", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Locked down",
      teamId: seeded.teamId,
    });
    const base = `/workspaces/${seeded.organizationId}/issues/${issue.id}`;

    // Open issue: member can comment.
    const commentRes = await fetch(
      `${base}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "visible" }),
      },
      seeded.otherToken
    );
    expect(commentRes.status).toBe(201);

    await grant(seeded, issue.id, ADMIN_ID);

    for (const path of [
      `${base}/comments`,
      `${base}/activity`,
      `${base}/history`,
      `${base}/attachments`,
      `${base}/relations`,
      `${base}/subscribers`,
      `${base}/documents`,
      `${base}/pr`,
    ]) {
      const res = await fetch(path, {}, seeded.otherToken);
      expect(res.status, `GET ${path}`).toBe(404);
    }

    // Writes are denied the same way.
    const blockedComment = await fetch(
      `${base}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "still locked" }),
      },
      seeded.otherToken
    );
    expect(blockedComment.status).toBe(404);
  });

  it("excludes restricted issues from notifications", async () => {
    // Member is the assignee: updates notify them while the issue is open.
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Member assigned issue",
      teamId: seeded.teamId,
      assigneeId: MEMBER_ID,
    });
    const before = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/notifications`,
        {},
        seeded.memberToken
      )
    ).json<{ notifications: Array<{ issueId: string | null }> }>();
    expect(before.notifications.some((n) => n.issueId === issue.id)).toBe(true);

    await grant(seeded, issue.id, ADMIN_ID);

    const after = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/notifications`,
        {},
        seeded.memberToken
      )
    ).json<{ notifications: Array<{ issueId: string | null }> }>();
    expect(after.notifications.some((n) => n.issueId === issue.id)).toBe(false);
  });

  it("filters restricted issues from the realtime socket stream", async () => {
    const restricted = await createIssue(
      seeded.organizationId,
      seeded.adminToken,
      { title: "Realtime restricted issue", teamId: seeded.teamId }
    );
    const open = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Realtime open issue",
      teamId: seeded.teamId,
    });
    await grant(seeded, restricted.id, OTHER_ID);

    // Both realtime endpoints must filter per-socket.
    for (const path of ["realtime", "ws"]) {
      const res = await app.fetch(
        new Request(
          `https://example.com/workspaces/${seeded.organizationId}/${path}`,
          {
            headers: {
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
              Authorization: `Bearer ${seeded.memberToken}`,
            },
          }
        ),
        env
      );
      expect(res.status, `GET /${path}`).toBe(101);
      const ws = res.webSocket!;
      ws.accept();

      const frames: string[] = [];
      ws.addEventListener("message", (event) =>
        frames.push(String(event.data))
      );

      // Drain the `connected` frame, then touch the restricted issue followed
      // by the open one — the open update proves the socket is live.
      await waitFor(() => frames.some((f) => f.includes('"connected"')));
      await fetch(
        `/workspaces/${seeded.organizationId}/issues/${restricted.id}`,
        { method: "PATCH", body: JSON.stringify({ title: "retitled" }) },
        seeded.adminToken
      );
      await fetch(
        `/workspaces/${seeded.organizationId}/issues/${open.id}`,
        { method: "PATCH", body: JSON.stringify({ title: "retitled open" }) },
        seeded.adminToken
      );

      await waitFor(() =>
        frames.some((f) => f.includes('"issue.updated"') && f.includes(open.id))
      );
      expect(
        frames.some((f) => f.includes(restricted.id)),
        `/${path} leaked a restricted issue event`
      ).toBe(false);
      ws.close();
    }
  });

  it("denies session registration on restricted issues", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Restricted lane target",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, OTHER_ID);

    // Registering mints a lane token (which bypasses session-level checks)
    // and embeds the title in the session label — members must not reach it.
    const res = await fetch(
      `/workspaces/${seeded.organizationId}/agent/sessions/register`,
      {
        method: "POST",
        body: JSON.stringify({ issueId: issue.id, provider: "devin" }),
      },
      seeded.memberToken
    );
    expect(res.status).toBe(404);
  });

  it("keeps grant management admin-only", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Grant management test",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, MEMBER_ID);

    // A granted member can see the issue but cannot revoke grants (that
    // would declassify it) nor add new ones.
    const base = `/workspaces/${seeded.organizationId}/issues/${issue.id}/permissions`;
    const revokeRes = await fetch(
      `${base}/${MEMBER_ID}`,
      { method: "DELETE" },
      seeded.memberToken
    );
    expect(revokeRes.status).toBe(403);
    const grantSelf = await fetch(
      base,
      { method: "PUT", body: JSON.stringify({ actorId: OTHER_ID }) },
      seeded.memberToken
    );
    expect(grantSelf.status).toBe(403);

    // Nor can a member restrict an open issue to themselves.
    const open = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Open issue hijack target",
      teamId: seeded.teamId,
    });
    const hijack = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${open.id}/permissions`,
      { method: "PUT", body: JSON.stringify({ actorId: MEMBER_ID }) },
      seeded.memberToken
    );
    expect(hijack.status).toBe(403);
    expect(
      (
        await fetch(
          `/workspaces/${seeded.organizationId}/issues/${open.id}`,
          {},
          seeded.otherToken
        )
      ).status
    ).toBe(200);
  });

  it("keeps a deleted restricted issue's audit entries hidden", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Soon deleted restricted issue",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, OTHER_ID);
    await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}`,
      { method: "PATCH", body: JSON.stringify({ title: "retitled" }) },
      seeded.adminToken
    );
    const del = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}`,
      { method: "DELETE" },
      seeded.adminToken
    );
    expect(del.status).toBe(204);

    // The audit trail outlives the issue; its entries (title diffs included)
    // must stay filtered for members without a grant.
    const audit = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/audit-log?entityType=issue`,
        {},
        seeded.memberToken
      )
    ).json<{ entries: Array<{ entityId: string }> }>();
    expect(audit.entries.some((e) => e.entityId === issue.id)).toBe(false);
  });

  it("gates issue references on customer needs", async () => {
    const issue = await createIssue(seeded.organizationId, seeded.adminToken, {
      title: "Restricted need target",
      teamId: seeded.teamId,
    });
    await grant(seeded, issue.id, OTHER_ID);

    const customer = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/customers`,
        { method: "POST", body: JSON.stringify({ name: "Acme" }) },
        seeded.adminToken
      )
    ).json<{ id: string }>();

    // Linking a need to a restricted issue must fail like a missing issue.
    const link = await fetch(
      `/workspaces/${seeded.organizationId}/customer-needs`,
      {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, issueId: issue.id }),
      },
      seeded.memberToken
    );
    expect(link.status).toBe(404);

    // Filtering needs by a restricted ref is denied identically.
    const filtered = await fetch(
      `/workspaces/${seeded.organizationId}/customer-needs?issueId=${issue.id}`,
      {},
      seeded.memberToken
    );
    expect(filtered.status).toBe(404);

    // An existing link's issueId is scrubbed from the member's view.
    const linked = await fetch(
      `/workspaces/${seeded.organizationId}/customer-needs`,
      {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, issueId: issue.id }),
      },
      seeded.adminToken
    );
    expect(linked.status).toBe(201);
    const memberNeeds = await (
      await fetch(
        `/workspaces/${seeded.organizationId}/customer-needs`,
        {},
        seeded.memberToken
      )
    ).json<{ needs: Array<{ id: string; issueId: string | null }> }>();
    expect(memberNeeds.needs.map((n) => n.issueId)).not.toContain(issue.id);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for frame");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

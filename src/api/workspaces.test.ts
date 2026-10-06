import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member, ssoProvider } from "../global/schema.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

const origin = (
  env.ALLOWED_ORIGINS ??
  env.BETTER_AUTH_URL ??
  "https://pile.example.workers.dev"
)
  .toString()
  .split(",")[0]
  .trim();
const onboardUrl = new URL("/workspaces/onboard", origin).toString();

async function getSessionCookie(): Promise<string> {
  const auth = await createAuth(env);
  const email = `onboard-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({
    body: { email, password, name: "Onboard User" },
  });
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookies = signInRes.headers.getSetCookie();
  const cookie = setCookies.find((c) =>
    c.includes("better-auth.session_token=")
  );
  if (!cookie) {
    throw new Error("No session cookie");
  }
  return cookie;
}

describe("workspaces API", () => {
  it("rejects onboarding without a human session", async () => {
    const res = await app.fetch(
      new Request(onboardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          name: "Onboarded",
          slug: `onboard-${crypto.randomUUID()}`,
        }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("lists only the user's workspaces", async () => {
    const cookie = await getSessionCookie();
    const res = await app.fetch(
      new Request(new URL("/workspaces", origin).toString(), {
        headers: { Cookie: cookie, Origin: origin },
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: { id: string }[] };
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces).toHaveLength(0);
  });

  it("onboards a workspace with a default team and admin token", async () => {
    const cookie = await getSessionCookie();
    const res = await app.fetch(
      new Request(onboardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          name: "Onboarded",
          slug: `onboard-${crypto.randomUUID()}`,
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { id: string };
      team: { name: string; key: string };
      token: string;
    };
    expect(body.workspace.id).toBeDefined();
    expect(body.team.name).toBe("General");
    expect(body.team.key).toBe("general");
    expect(body.token).toBeDefined();
  });

  it("requires auth and matching scope to read a workspace", async () => {
    const cookie = await getSessionCookie();
    const onboard = async () => {
      const res = await app.fetch(
        new Request(onboardUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify({
            name: "Scoped",
            slug: `scoped-${crypto.randomUUID()}`,
          }),
        }),
        env
      );
      return (await res.json()) as {
        workspace: { id: string; slug: string };
        token: string;
      };
    };
    const ws1 = await onboard();
    const ws2 = await onboard();

    const anon = await app.fetch(
      new Request(
        new URL(`/workspaces/${ws1.workspace.id}`, origin).toString()
      ),
      env
    );
    expect(anon.status).toBe(401);

    const own = await app.fetch(
      new Request(
        new URL(`/workspaces/${ws1.workspace.id}`, origin).toString(),
        {
          headers: { Authorization: `Bearer ${ws1.token}` },
        }
      ),
      env
    );
    expect(own.status).toBe(200);

    const foreign = await app.fetch(
      new Request(
        new URL(`/workspaces/${ws1.workspace.id}`, origin).toString(),
        {
          headers: { Authorization: `Bearer ${ws2.token}` },
        }
      ),
      env
    );
    expect(foreign.status).toBe(403);

    const memberSession = await app.fetch(
      new Request(
        new URL(`/workspaces/${ws1.workspace.id}`, origin).toString(),
        {
          headers: { Cookie: cookie },
        }
      ),
      env
    );
    expect(memberSession.status).toBe(200);

    const anonSlug = await app.fetch(
      new Request(
        new URL(`/workspaces/slug/${ws1.workspace.slug}`, origin).toString()
      ),
      env
    );
    expect(anonSlug.status).toBe(401);

    const memberSlug = await app.fetch(
      new Request(
        new URL(`/workspaces/slug/${ws1.workspace.slug}`, origin).toString(),
        { headers: { Cookie: cookie } }
      ),
      env
    );
    expect(memberSlug.status).toBe(200);

    const foreignSlug = await app.fetch(
      new Request(
        new URL(`/workspaces/slug/${ws1.workspace.slug}`, origin).toString(),
        { headers: { Authorization: `Bearer ${ws2.token}` } }
      ),
      env
    );
    expect(foreignSlug.status).toBe(403);
  });

  it("toggles ssoEnforced via PATCH and enforces it on member sessions", async () => {
    const cookie = await getSessionCookie();
    const res = await app.fetch(
      new Request(onboardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          name: "SSO Org",
          slug: `sso-${crypto.randomUUID()}`,
        }),
      }),
      env
    );
    const onboarded = (await res.json()) as {
      workspace: { id: string };
      token: string;
    };
    const orgId = onboarded.workspace.id;

    const patch = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}`, origin).toString(), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({ ssoEnforced: true }),
      }),
      env
    );
    expect(patch.status).toBe(200);

    // Second member with a plain (non-SSO) session gets rejected.
    const memberCookie = await getSessionCookie();
    const db = createD1(env.D1);
    const auth = await createAuth(env);
    const sessionData = await auth.api.getSession({
      headers: new Headers({ Cookie: memberCookie }),
    });
    const memberUserId = sessionData?.user?.id;
    if (!memberUserId) {
      throw new Error("member session not established");
    }
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: memberUserId,
      role: "member",
      createdAt: new Date(),
    });

    await db.insert(ssoProvider).values({
      id: crypto.randomUUID(),
      issuer: "https://idp.example.com",
      providerId: `sso-${crypto.randomUUID()}`,
      organizationId: orgId,
      domain: "example.com",
    });

    const issues = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}/issues`, origin).toString(), {
        headers: { Cookie: memberCookie, Origin: origin },
      }),
      env
    );
    expect(issues.status).toBe(403);
    const body = (await issues.json()) as { code?: string };
    expect(body.code).toBe("SSO_REQUIRED");

    // Workspace API tokens are machine credentials — unaffected.
    const tokenRes = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}/issues`, origin).toString(), {
        headers: { Authorization: `Bearer ${onboarded.token}` },
      }),
      env
    );
    expect(tokenRes.status).toBe(200);

    // The org owner without an SSO-linked account is also rejected.
    const ownerRes = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}/issues`, origin).toString(), {
        headers: { Cookie: cookie, Origin: origin },
      }),
      env
    );
    expect(ownerRes.status).toBe(403);

    // PATCH /workspaces/{id} is owner/admin-gated but not org-scoped
    // middleware, so an owner can always unenforce — the lockout escape hatch.
    const unpatch = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}`, origin).toString(), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({ ssoEnforced: false }),
      }),
      env
    );
    expect(unpatch.status).toBe(200);

    const restored = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}/issues`, origin).toString(), {
        headers: { Cookie: memberCookie, Origin: origin },
      }),
      env
    );
    expect(restored.status).toBe(200);
  });
  it("reassigns the default team and deletes the old one once empty", async () => {
    const cookie = await getSessionCookie();
    const res = await app.fetch(
      new Request(onboardUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({
          name: "Default team org",
          slug: `default-team-${crypto.randomUUID()}`,
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const onboarded = (await res.json()) as {
      workspace: { id: string; defaultTeamId: string | null };
      team: { id: string };
      token: string;
    };
    const orgId = onboarded.workspace.id;
    const general = onboarded.team.id;
    expect(onboarded.workspace.defaultTeamId).toBe(general);

    const api = (path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(new URL(path, origin).toString(), {
          ...init,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${onboarded.token}`,
          },
        }),
        env
      );
    const patchWorkspace = (body: unknown) =>
      app.fetch(
        new Request(new URL(`/workspaces/${orgId}`, origin).toString(), {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify(body),
        }),
        env
      );
    const listTeams = async () => {
      const list = await api(`/workspaces/${orgId}/teams`);
      expect(list.status).toBe(200);
      return (
        (await list.json()) as {
          teams: { id: string; isDefault: boolean }[];
        }
      ).teams;
    };
    const createTeam = async (key: string) => {
      const created = await api(`/workspaces/${orgId}/teams`, {
        method: "POST",
        body: JSON.stringify({ key, name: key }),
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { id: string }).id;
    };

    // Onboarding provisions exactly one default team.
    expect(
      (await listTeams()).map((t) => ({ id: t.id, isDefault: t.isDefault }))
    ).toEqual([{ id: general, isDefault: true }]);

    const eng = await createTeam("eng");
    const ops = await createTeam("ops");

    const blocked = await api(`/workspaces/${orgId}/teams/${general}`, {
      method: "DELETE",
    });
    expect(blocked.status).toBe(400);

    // Plain members cannot reassign the default.
    const memberCookie = await getSessionCookie();
    const memberUserId = (
      await (
        await createAuth(env)
      ).api.getSession({
        headers: new Headers({ Cookie: memberCookie }),
      })
    )?.user?.id;
    if (!memberUserId) throw new Error("member session not established");
    await createD1(env.D1).insert(member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: memberUserId,
      role: "member",
      createdAt: new Date(),
    });
    const forbidden = await app.fetch(
      new Request(new URL(`/workspaces/${orgId}`, origin).toString(), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: origin,
        },
        body: JSON.stringify({ defaultTeamId: eng }),
      }),
      env
    );
    expect(forbidden.status).toBe(403);

    const missing = await patchWorkspace({ defaultTeamId: "no-such-team" });
    expect(missing.status).toBe(404);

    const patched = await patchWorkspace({ defaultTeamId: eng });
    expect(patched.status).toBe(200);
    expect(
      ((await patched.json()) as { defaultTeamId: string | null }).defaultTeamId
    ).toBe(eng);
    const teams = await listTeams();
    expect(teams.filter((t) => t.isDefault).map((t) => t.id)).toEqual([eng]);

    // Issues created without a teamId now land on the new default.
    const defaulted = await api(`/workspaces/${orgId}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "lands on default" }),
    });
    expect(defaulted.status).toBe(201);
    expect(((await defaulted.json()) as { teamId: string }).teamId).toBe(eng);

    // A non-default team that still owns issues cannot be deleted.
    const pinned = await api(`/workspaces/${orgId}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "pins general", teamId: general }),
    });
    expect(pinned.status).toBe(201);
    const pinnedId = ((await pinned.json()) as { id: string }).id;
    const nonEmpty = await api(`/workspaces/${orgId}/teams/${general}`, {
      method: "DELETE",
    });
    expect(nonEmpty.status).toBe(409);

    const moved = await api(`/workspaces/${orgId}/issues/${pinnedId}`, {
      method: "PATCH",
      body: JSON.stringify({ teamId: ops }),
    });
    expect(moved.status).toBe(200);

    const deleted = await api(`/workspaces/${orgId}/teams/${general}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(new Set((await listTeams()).map((t) => t.id))).toEqual(
      new Set([eng, ops])
    );
  });
});

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member } from "../global/schema.js";
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
const scimBase = new URL("/api/auth/scim/v2", origin).toString();

async function getSessionCookie(): Promise<string> {
  const auth = await createAuth(env);
  const email = `scim-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({
    body: { email, password, name: "SCIM Admin" },
  });
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = signInRes.headers
    .getSetCookie()
    .find((c) => c.includes("better-auth.session_token="));
  if (!cookie) {
    throw new Error("No session cookie");
  }
  return cookie;
}

async function onboard(cookie: string) {
  const res = await app.fetch(
    new Request(onboardUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({
        name: "SCIM WS",
        slug: `scim-${crypto.randomUUID()}`,
      }),
    }),
    env
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { workspace: { id: string } };
}

function scimFetch(path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(new URL(path, scimBase).toString(), {
      ...init,
      headers: {
        "Content-Type": "application/scim+json",
        ...init.headers,
      },
    }),
    env
  );
}

describe("SCIM provisioning", () => {
  it("rejects SCIM requests without a bearer token", async () => {
    const res = await scimFetch("/api/auth/scim/v2/Users");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown bearer token", async () => {
    const res = await scimFetch("/api/auth/scim/v2/Users", {
      headers: { Authorization: "Bearer bogus-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects connection creation from a non-member", async () => {
    const cookie = await getSessionCookie();
    const { workspace } = await onboard(await getSessionCookie());
    const res = await app.fetch(
      new Request(
        new URL(`/workspaces/${workspace.id}/scim/connections`, origin),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify({}),
        }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("mints a connection, provisions a user into the workspace, and deactivates", async () => {
    const cookie = await getSessionCookie();
    const { workspace } = await onboard(cookie);

    const create = await app.fetch(
      new Request(
        new URL(`/workspaces/${workspace.id}/scim/connections`, origin),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify({}),
        }
      ),
      env
    );
    expect(create.status).toBe(201);
    const conn = (await create.json()) as {
      connectionId: string;
      token: string;
      baseUrl: string;
    };
    expect(conn.token).toBeDefined();
    expect(conn.baseUrl).toContain("/scim/v2");

    const authz = { Authorization: `Bearer ${conn.token}` };

    // Connection is visible via the admin list route.
    const list = await app.fetch(
      new Request(
        new URL(`/workspaces/${workspace.id}/scim/connections`, origin),
        { headers: { Cookie: cookie, Origin: origin } }
      ),
      env
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      connections: { connectionId: string }[];
    };
    expect(
      listed.connections.some((c) => c.connectionId === conn.connectionId)
    ).toBe(true);

    // Provision a user — POST /Users.
    const userRes = await scimFetch("/api/auth/scim/v2/Users", {
      method: "POST",
      headers: authz,
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "provisioned@example.com",
        name: { givenName: "Pro", familyName: "Visioned" },
        emails: [{ value: "provisioned@example.com", primary: true }],
        externalId: "idp-user-1",
        active: true,
      }),
    });
    expect(userRes.status).toBe(201);
    const scimUser = (await userRes.json()) as {
      id: string;
      userName: string;
      active: boolean;
    };
    expect(scimUser.userName).toBe("provisioned@example.com");
    expect(scimUser.active).toBe(true);

    // The provisioned user landed as a member of the workspace.
    const db = createD1(env.D1);
    const rows = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.organizationId, workspace.id));
    expect(rows.length).toBe(2); // onboarder + provisioned
    expect(rows.some((r) => r.role === "member")).toBe(true);

    // Deactivate via PATCH active:false → member row removed.
    const patch = await scimFetch(`/api/auth/scim/v2/Users/${scimUser.id}`, {
      method: "PATCH",
      headers: authz,
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    });
    expect(patch.status).toBe(200);

    const after = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.organizationId, workspace.id));
    expect(after.length).toBe(1); // only the onboarder remains
  });

  it("scopes credentials to their connection domain", async () => {
    const cookie = await getSessionCookie();
    const ws1 = await onboard(cookie);
    const ws2 = await onboard(cookie);

    const mint = async (orgId: string) => {
      const res = await app.fetch(
        new Request(new URL(`/workspaces/${orgId}/scim/connections`, origin), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify({ scopes: ["scim.users.read"] }),
        }),
        env
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };
    const token1 = await mint(ws1.workspace.id);
    const token2 = await mint(ws2.workspace.id);

    // A read-only token cannot write users.
    const write = await scimFetch("/api/auth/scim/v2/Users", {
      method: "POST",
      headers: { Authorization: `Bearer ${token1}` },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "x@example.com",
      }),
    });
    expect(write.status).toBe(403);

    // Both tokens can read their own user lists (each scoped to its domain).
    for (const token of [token1, token2]) {
      const res = await scimFetch("/api/auth/scim/v2/Users", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });
});

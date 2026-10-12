import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { createMembership } from "../global/workspace-entities.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

const origin = (
  env.ALLOWED_ORIGINS ??
  env.BETTER_AUTH_URL ??
  "https://pile.example.workers.dev"
).toString();

const sessionUserSchema = z.object({ user: z.object({ id: z.string() }) });

async function createSignedInUser(name: string) {
  const auth = await createAuth(env);
  const email = `guest-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({ body: { email, password, name } });
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.includes("session_token="))
    ?.split(";")[0];
  if (!cookie) throw new Error("No session cookie");
  const session = await auth.api.getSession({
    headers: new Headers({ Cookie: cookie }),
  });
  const { user } = sessionUserSchema.parse(session);
  return { cookie, userId: user.id };
}

async function onboardWorkspace(cookie: string, name: string) {
  const res = await app.fetch(
    new Request(new URL("/workspaces/onboard", origin).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({
        name,
        slug: `guest-${crypto.randomUUID()}`,
      }),
    }),
    env
  );
  expect(res.status).toBe(201);
  return z
    .object({
      workspace: z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
      }),
      token: z.string(),
    })
    .parse(await res.json());
}

/** Guests are full members locked to the documents surface. */
describe("guest access", () => {
  it("denies guests off-surface routes, allows documents", async () => {
    const owner = await createSignedInUser("Guest Test Owner");
    const guest = await createSignedInUser("Guest Test Guest");
    const onboarded = await onboardWorkspace(owner.cookie, "Guest Space");
    const db = createD1(env.D1);
    await createMembership(
      db,
      env,
      onboarded.workspace.id,
      guest.userId,
      "guest" as "member"
    );

    // sanity: the guest session resolves
    const auth = await createAuth(env);
    const session = await auth.api.getSession({
      headers: new Headers({ Cookie: guest.cookie }),
    });
    expect(session?.user?.id).toBe(guest.userId);

    const issues = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/issues`,
      { headers: { Cookie: guest.cookie, Origin: origin } }
    );
    expect(issues.status).toBe(403);

    const tickets = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/support/tickets`,
      { headers: { Cookie: guest.cookie, Origin: origin } }
    );
    expect(tickets.status).toBe(403);

    const docs = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents`,
      { headers: { Cookie: guest.cookie, Origin: origin } }
    );
    expect(docs.status).toBe(200);
  });
});

describe("member document visibility", () => {
  it("hides restricted docs from ungranted members in the list", async () => {
    const owner = await createSignedInUser("List Owner");
    const member = await createSignedInUser("List Member");
    const onboarded = await onboardWorkspace(owner.cookie, "List Space");
    const db = createD1(env.D1);
    await createMembership(
      db,
      env,
      onboarded.workspace.id,
      member.userId,
      "member"
    );

    // owner creates one open doc + one restricted doc
    const headers = {
      Cookie: owner.cookie,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const open_ = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Open doc" }),
      }
    );
    expect(open_.status).toBe(201);
    const restricted = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Restricted doc" }),
      }
    );
    expect(restricted.status).toBe(201);
    const restrictedId = (await restricted.json()) as { id: string };

    // restrict it to the owner only — grant row to the owner
    const grant = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents/${restrictedId.id}/permissions`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          actorId: owner.userId,
          level: "edit",
        }),
      }
    );
    expect(grant.status).toBe(200);

    // member list: sees the open doc, not the restricted one
    const list = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents`,
      { headers: { Cookie: member.cookie, Origin: origin } }
    );
    expect(list.status).toBe(200);
    const titles = ((await list.json()) as { documents: { title: string }[] })
      .documents.map((d) => d.title);
    expect(titles).toContain("Open doc");
    expect(titles).not.toContain("Restricted doc");

    // member detail: 404 on the restricted doc
    const detail = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents/${restrictedId.id}`,
      { headers: { Cookie: member.cookie, Origin: origin } }
    );
    expect(detail.status).toBe(404);
  });
});

describe("custom roles (dynamic access control)", () => {
  it("a custom role enforces its statements end to end", async () => {
    const owner = await createSignedInUser("Role Owner");
    const limited = await createSignedInUser("Role Limited");
    const onboarded = await onboardWorkspace(owner.cookie, "Role Space");
    const auth = await createAuth(env);
    const db = createD1(env.D1);

    // BA-official role creation — statements live on the
    // organizationRole row.
    await auth.api.createOrgRole({
      body: {
        organizationId: onboarded.workspace.id,
        role: "viewer",
        permission: { issue: ["view"] },
      },
      headers: new Headers({ Cookie: owner.cookie }),
    });
    await createMembership(
      db,
      env,
      onboarded.workspace.id,
      limited.userId,
      "viewer"
    );

    // view allowed
    const list = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/issues`,
      { headers: { Cookie: limited.cookie, Origin: origin } }
    );
    expect(list.status).toBe(200);

    // create denied — the role has no issue:create
    const create = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/issues`,
      {
        method: "POST",
        headers: {
          Cookie: limited.cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "nope" }),
      }
    );
    expect(create.status).toBe(403);

    // different resource denied
    const docs = await SELF.fetch(
      `${origin}/workspaces/${onboarded.workspace.id}/documents`,
      {
        method: "POST",
        headers: {
          Cookie: limited.cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "nope" }),
      }
    );
    expect(docs.status).toBe(403);
  });
});

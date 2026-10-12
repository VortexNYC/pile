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

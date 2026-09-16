import { env } from "cloudflare:test";
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
)
  .toString()
  .split(",")[0]
  .trim();

const sessionUserSchema = z.object({
  user: z.object({ id: z.string() }),
});

const onboardSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  token: z.string(),
});

const workspacesSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
    })
  ),
});

const authorizeSchema = z.object({
  token: z.string().min(1),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
});

async function createSignedInUser(name: string) {
  const auth = createAuth(env);
  const email = `clipper-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({
    body: { email, password, name },
  });
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookies = signInRes.headers.getSetCookie();
  const cookie = setCookies.find((value) =>
    value.includes("better-auth.session_token=")
  );
  if (!cookie) {
    throw new Error("No session cookie");
  }
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
        slug: `clipper-${crypto.randomUUID()}`,
      }),
    }),
    env
  );
  expect(res.status).toBe(201);
  return onboardSchema.parse(await res.json());
}

async function clipperFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("Origin")) {
    headers.set("Origin", origin);
  }
  return app.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers,
    }),
    env
  );
}

describe("clipper authorize API", () => {
  it("rejects listing workspaces without a human session", async () => {
    const res = await clipperFetch("/clipper/workspaces");
    expect(res.status).toBe(401);
  });

  it("lists only workspaces the signed-in user belongs to", async () => {
    const owner = await createSignedInUser("Clipper Owner");
    const outsider = await createSignedInUser("Clipper Outsider");
    const onboarded = await onboardWorkspace(owner.cookie, "Owner Space");
    await onboardWorkspace(outsider.cookie, "Other Space");

    const res = await clipperFetch("/clipper/workspaces", {
      headers: { Cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
    const body = workspacesSchema.parse(await res.json());
    expect(body.workspaces.map((workspace) => workspace.id)).toEqual([
      onboarded.workspace.id,
    ]);
  });

  it("mints a write token members can use to capture", async () => {
    const owner = await createSignedInUser("Clipper Capturer");
    const onboarded = await onboardWorkspace(owner.cookie, "Capture Space");

    const authorizeRes = await clipperFetch("/clipper/authorize", {
      method: "POST",
      headers: { Cookie: owner.cookie },
      body: JSON.stringify({ workspaceId: onboarded.workspace.id }),
    });
    expect(authorizeRes.status).toBe(201);
    const authorized = authorizeSchema.parse(await authorizeRes.json());
    expect(authorized.workspace.id).toBe(onboarded.workspace.id);

    const captureRes = await clipperFetch(
      `/workspaces/${onboarded.workspace.id}/capture`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${authorized.token}` },
        body: JSON.stringify({
          url: "https://example.com/article",
          title: "Example article",
          selection: "quoted text",
          source: "pile-clipper",
        }),
      }
    );
    expect(captureRes.status).toBe(201);
    const captured = z
      .object({ identifier: z.string().nullable() })
      .parse(await captureRes.json());
    expect(captured.identifier).toBeTruthy();
  });

  it("lets a non-admin member authorize the clipper", async () => {
    const owner = await createSignedInUser("Clipper Admin");
    const member = await createSignedInUser("Clipper Member");
    const onboarded = await onboardWorkspace(owner.cookie, "Shared Space");
    const db = createD1(env.D1);
    await createMembership(
      db,
      env,
      onboarded.workspace.id,
      member.userId,
      "member"
    );

    const res = await clipperFetch("/clipper/authorize", {
      method: "POST",
      headers: { Cookie: member.cookie },
      body: JSON.stringify({ workspaceId: onboarded.workspace.id }),
    });
    expect(res.status).toBe(201);
    const authorized = authorizeSchema.parse(await res.json());
    expect(authorized.token).toBeTruthy();
  });

  it("rejects authorizing a workspace the user does not belong to", async () => {
    const owner = await createSignedInUser("Clipper Owner 2");
    const outsider = await createSignedInUser("Clipper Stranger");
    const onboarded = await onboardWorkspace(owner.cookie, "Private Space");

    const res = await clipperFetch("/clipper/authorize", {
      method: "POST",
      headers: { Cookie: outsider.cookie },
      body: JSON.stringify({ workspaceId: onboarded.workspace.id }),
    });
    expect(res.status).toBe(403);
  });
});

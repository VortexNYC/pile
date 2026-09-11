import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";
import { createAuth } from "../platform/auth.js";

async function getSessionCookie(): Promise<string> {
  const auth = createAuth(env);
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
    c.startsWith("better-auth.session_token")
  );
  if (!cookie) {
    throw new Error("No session cookie");
  }
  return cookie;
}

describe("workspaces API", () => {
  it("rejects onboarding without a human session", async () => {
    const res = await app.fetch(
      new Request("https://example.com/workspaces/onboard", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8788",
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

  it("onboards a workspace with a default team and admin token", async () => {
    const cookie = await getSessionCookie();
    const res = await app.fetch(
      new Request("https://example.com/workspaces/onboard", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://127.0.0.1:8788",
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
});

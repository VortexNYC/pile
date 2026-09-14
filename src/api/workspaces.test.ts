import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
});

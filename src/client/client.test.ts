import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createPileClient } from "../../packages/cli/src/client/index.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

async function getSessionCookie(): Promise<string> {
  const auth = createAuth(env);
  const email = `client-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  await auth.api.signUpEmail({
    body: { email, password, name: "Client User" },
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
  return cookie.split(";")[0];
}

describe("typed client integration", () => {
  it("lists workspaces", async () => {
    const cookie = await getSessionCookie();
    const client = createPileClient({
      baseUrl: "http://localhost",
      auth: { type: "session", cookie },
      fetch: async (request) => app.fetch(request, env),
    });

    const { data, error } = await client.GET("/workspaces");

    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(Array.isArray(data!.workspaces)).toBe(true);
  });
});

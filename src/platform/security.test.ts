import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";
import type { WorkerEnv } from "./middleware.js";
import { allowedOrigins } from "./security.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

describe("allowedOrigins", () => {
  it("parses BETTER_AUTH_URL and ALLOWED_ORIGINS into origins", () => {
    const origins = allowedOrigins({
      BETTER_AUTH_URL: "https://pile.nyc",
      ALLOWED_ORIGINS: "https://pile.nyc, https://app.pile.nyc",
    } as WorkerEnv);
    expect(origins.has("https://pile.nyc")).toBe(true);
    expect(origins.has("https://app.pile.nyc")).toBe(true);
  });

  it("ignores malformed URLs and empty input", () => {
    expect(
      allowedOrigins({ BETTER_AUTH_URL: "not a url" } as WorkerEnv).size
    ).toBe(0);
    expect(allowedOrigins({} as WorkerEnv).size).toBe(0);
  });
});

describe("public-path CSRF gate (PILE-620)", () => {
  it("lets unauthenticated POSTs through on /oauth/* and /.well-known/*", async () => {
    // /oauth/register is a POST with no Bearer token — it must pass the
    // CSRF origin gate even with a foreign Origin header.
    const res = await app.fetch(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example.com",
        },
        body: JSON.stringify({ client_name: "CSRF probe" }),
      }),
      env
    );
    expect(res.status).toBe(201);
  });

  it("still gates non-public mutation paths without a matching origin", async () => {
    const res = await app.fetch(
      new Request("http://localhost/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.example.com",
        },
        body: JSON.stringify({ name: "x", slug: "x" }),
      }),
      env
    );
    expect(res.status).toBe(403);
  });
});

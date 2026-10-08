import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

describe("agent sessions dashboard", () => {
  it("serves the operator dashboard at /agents", async () => {
    const res = await app.fetch(new Request("https://example.com/agents"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Agent sessions");
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).toContain("/agent/sessions");
  });
});

describe("member console", () => {
  const assets = {
    fetch: async (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/") {
        return new Response("<!doctype html><div id=app></div>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname === "/assets/index.js") {
        return new Response("console.log(1)", {
          headers: { "content-type": "text/javascript" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  };
  const withAssets = { ...env, ASSETS: assets };

  it("serves the SPA shell for client routes under /app", async () => {
    for (const path of ["/app", "/app/", "/app/acme/issues/abc"]) {
      const res = await app.fetch(
        new Request(`https://example.com${path}`),
        withAssets
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<div id=app>");
    }
  });

  it("maps /app asset files onto the asset tree", async () => {
    const res = await app.fetch(
      new Request("https://example.com/app/assets/index.js"),
      withAssets
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    const missing = await app.fetch(
      new Request("https://example.com/app/assets/nope.js"),
      withAssets
    );
    expect(missing.status).toBe(404);
  });

  it("reports an unbuilt console instead of crashing", async () => {
    const res = await app.fetch(new Request("https://example.com/app"), {
      ...env,
      ASSETS: undefined,
    });
    expect(res.status).toBe(503);
  });
});

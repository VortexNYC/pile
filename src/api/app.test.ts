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

  it("survives immutable asset-binding headers", async () => {
    // The real ASSETS binding returns Responses with immutable headers —
    // secureHeaders() mutating c.res used to throw INTERNAL_ERROR (500)
    // on every asset file, blanking the console in production.
    const immutableAsset = new Response("console.log(1)", {
      headers: { "content-type": "text/javascript" },
    });
    Object.defineProperty(immutableAsset, "headers", {
      value: new Proxy(immutableAsset.headers, {
        get: (target, prop) => {
          if (prop === "set" || prop === "append" || prop === "delete") {
            return () => {
              throw new TypeError("Can't modify immutable headers");
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    const res = await app.fetch(
      new Request("https://example.com/app/assets/index.js"),
      { ...env, ASSETS: { fetch: async () => immutableAsset } }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("reports an unbuilt console instead of crashing", async () => {
    const res = await app.fetch(new Request("https://example.com/app"), {
      ...env,
      ASSETS: undefined,
    });
    expect(res.status).toBe(503);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

interface StatusBody {
  status: "operational" | "degraded";
  version: string;
  sha: string | null;
  timestamp: string;
  components: {
    api: { status: string; latencyMs?: number };
    database: { status: string; latencyMs?: number };
    durableObjects: { status: string; latencyMs?: number };
    storage: { status: string; latencyMs?: number };
  };
}

const degradedD1Env = () =>
  new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "D1") {
        return {
          prepare: () => {
            throw new Error("D1 unavailable");
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

describe("GET /status", () => {
  it("returns operational status with component health unauthenticated", async () => {
    const request = new Request("https://example.com/status");
    const res = await app.fetch(request, env);
    expect(res.status).toBe(200);

    const body = await res.json<StatusBody>();
    expect(body.status).toBe("operational");
    expect(body.version).toBe("0.1.1");
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.sha === null || typeof body.sha === "string").toBe(true);

    expect(body.components.api.status).toBe("operational");
    expect(body.components.database.status).toBe("operational");
    expect(typeof body.components.database.latencyMs).toBe("number");
    expect(body.components.durableObjects.status).toBe("operational");
    expect(body.components.storage.status).toBe("operational");
  });

  it("reports degraded when the D1 probe fails", async () => {
    const request = new Request("https://example.com/status");
    const res = await app.fetch(request, degradedD1Env());
    expect(res.status).toBe(503);

    const body = await res.json<StatusBody>();
    expect(body.status).toBe("degraded");
    expect(body.components.database.status).toBe("degraded");
    expect(body.components.api.status).toBe("operational");
    expect(body.components.durableObjects.status).toBe("operational");
    expect(body.components.storage.status).toBe("operational");
  });

  it("still returns JSON when the client asks for application/json", async () => {
    const request = new Request("https://example.com/status", {
      headers: { Accept: "application/json" },
    });
    const res = await app.fetch(request, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<StatusBody>();
    expect(body.status).toBe("operational");
  });

  it("renders an HTML status page when the client accepts text/html", async () => {
    const request = new Request("https://example.com/status", {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const res = await app.fetch(request, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("All systems operational");
    for (const label of ["API", "Database", "Durable Objects", "Storage"]) {
      expect(body).toContain(label);
    }
    expect(body).toContain("Operational");
    expect(body).toContain("ms");
    expect(body).toContain("version 0.1.1");
    expect(body).toContain('http-equiv="refresh" content="60"');
  });

  it("renders the degraded state in HTML when a component is down", async () => {
    const request = new Request("https://example.com/status", {
      headers: { Accept: "text/html" },
    });
    const res = await app.fetch(request, degradedD1Env());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("Some systems are degraded");
    expect(body).toContain("Degraded");
    expect(body).toContain("Operational");
  });
});

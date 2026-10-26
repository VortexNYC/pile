import { describe, expect, it } from "vitest";

import {
  capturePosthogEvent,
  captureProductEvent,
  isProductionTelemetryEnabled,
  PILE_POSTHOG_PROJECT_KEY,
  reportWorkerException,
  scrubRoutePath,
} from "./posthog.js";

describe("PostHog worker telemetry (PILE-597)", () => {
  it("gates telemetry off in non-production environments by default", () => {
    expect(isProductionTelemetryEnabled(undefined)).toBe(false);
    expect(
      isProductionTelemetryEnabled({ BETTER_AUTH_URL: "http://localhost:8787" })
    ).toBe(false);
    expect(
      isProductionTelemetryEnabled({
        BETTER_AUTH_URL: "https://staging.pile.nyc",
      })
    ).toBe(false);
    expect(
      isProductionTelemetryEnabled({ BETTER_AUTH_URL: "https://pile.nyc" })
    ).toBe(true);
  });

  it("posts $exception payloads via waitUntil and scrubs shared-document tokens", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const tasks: Promise<unknown>[] = [];
    reportWorkerException(
      "api",
      new RangeError("Maximum call stack size exceeded"),
      { waitUntil: (p) => tasks.push(p) },
      {
        method: "GET",
        path: "/shared-documents/org_vortex_main/secret-share-token-123",
        status: 500,
      },
      {
        fetchImpl: async (input, init) => {
          calls.push({
            url: String(input),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<
              string,
              unknown
            >,
          });
          return new Response("ok", { status: 200 });
        },
      }
    );
    await Promise.all(tasks);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://us.i.posthog.com/capture/");
    expect(calls[0].body.api_key).toBe(PILE_POSTHOG_PROJECT_KEY);
    expect(calls[0].body.event).toBe("$exception");
    const props = calls[0].body.properties as Record<string, unknown>;
    expect(props.$exception_type).toBe("RangeError");
    expect(props.$exception_message).toContain(
      "Maximum call stack size exceeded"
    );
    expect(props.path).toBe(
      "/shared-documents/org_vortex_main/[redacted-token]"
    );
    expect(scrubRoutePath("/workspaces/org_vortex_main/issues")).toBe(
      "/workspaces/org_vortex_main/issues"
    );
  });

  it("captures structured fleet events with product=pile", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tasks: Promise<unknown>[] = [];
    capturePosthogEvent(
      "pile_sweep_heartbeat",
      { orgCount: 4 },
      { waitUntil: (p) => tasks.push(p) },
      {
        fetchImpl: async (_input, init) => {
          calls.push(
            JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          );
          return new Response("ok", { status: 200 });
        },
      }
    );
    await Promise.all(tasks);
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe("pile_sweep_heartbeat");
    expect((calls[0].properties as Record<string, unknown>).product).toBe(
      "pile"
    );
  });
});

describe("captureProductEvent (PILE-632)", () => {
  it("derives distinct_id from actorId, then workspace, then worker", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_input: unknown, init?: RequestInit) => {
      calls.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      );
      return new Response("ok", { status: 200 });
    };
    captureProductEvent(
      "memory.remembered",
      { organizationId: "org-1", actorId: "user-9" },
      undefined,
      { fetchImpl }
    );
    captureProductEvent(
      "customer.batch_approved",
      { organizationId: "org-2" },
      undefined,
      { fetchImpl }
    );
    captureProductEvent("issue.created", {}, undefined, { fetchImpl });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(3);
    expect(calls[0].event).toBe("memory.remembered");
    expect((calls[0].properties as Record<string, unknown>).distinct_id).toBe(
      "user-9"
    );
    expect((calls[1].properties as Record<string, unknown>).distinct_id).toBe(
      "workspace:org-2"
    );
    expect((calls[2].properties as Record<string, unknown>).distinct_id).toBe(
      "pile-worker"
    );
  });
});

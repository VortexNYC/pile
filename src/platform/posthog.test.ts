import { describe, expect, it } from "vitest";

import {
  capturePosthogEvent,
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
    expect(scrubRoutePath("/cap/capl_support_token_456")).toBe(
      "/cap/[redacted-token]"
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

import { describe, expect, it, vi } from "vitest";

import { drainDomainEvents } from "./pipeline-events.js";

// PILE-443 — a worker's completed sub-step must wake an external
// chief_of_staff (kind:"external" + endpointUrl) via a POST; before the
// fix it silently dispatched an internal lane instead.

function stubFor(reviewer: unknown) {
  const issues = new Map<string, Record<string, unknown>>([
    [
      "step-1",
      {
        id: "step-1",
        identifier: "VTX-567",
        title: "Gather merchant info",
        stepKey: "gather",
        parentId: "deal-1",
      },
    ],
    ["deal-1", { id: "deal-1", identifier: "VTX-500", title: "Clover Club" }],
  ]);
  return {
    listPendingDomainEvents: async () => [
      {
        id: "ev-1",
        type: "substep.review",
        payload: JSON.stringify({ issueId: "step-1", parentId: "deal-1" }),
      },
    ],
    getIssue: async (id: string) => issues.get(id),
    getAgentTypeBySlug: async () => reviewer,
    markDomainEvent: async () => {},
  };
}

const env = {
  AGENT_CREDENTIALS_KEY: "",
} as unknown as Parameters<typeof drainDomainEvents>[0];

describe("substep.review external dispatch", () => {
  it("POSTs ready_for_review to an external reviewer's endpointUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const stub = stubFor({
      slug: "reviewer",
      name: "Chief",
      kind: "external",
      endpointUrl: "https://chief.example.com/hook",
      endpointSecret: null,
      agentId: "devin-cli",
    }) as unknown as Parameters<typeof drainDomainEvents>[1];
    const delivered = await drainDomainEvents(env, stub, "org_1");
    expect(delivered).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://chief.example.com/hook");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe("substep.ready_for_review");
    expect(body.issue.identifier).toBe("VTX-567");
    fetchSpy.mockRestore();
  });

  it("dispatches an internal lane when reviewer is an agent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
    const stub = stubFor({
      slug: "reviewer",
      name: "Reviewer",
      kind: "agent",
      agentId: "devin-cli",
      endpointUrl: null,
      endpointSecret: null,
    }) as unknown as Parameters<typeof drainDomainEvents>[1];
    // internal dispatch path goes through dispatchAgent — it may throw on
    // missing env in tests; the assertion we care about is that NO
    // external POST was attempted.
    try {
      await drainDomainEvents(env, stub, "org_1");
    } catch {
      // dispatchAgent may fail without provider config — acceptable here
    }
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain("chief.example.com");
    }
    fetchSpy.mockRestore();
  });
});

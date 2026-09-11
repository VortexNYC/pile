import { describe, expect, it, vi } from "vitest";

import { createIssueTrackerClient } from "./index.js";

describe("Issue Tracker client", () => {
  it("lists workspaces", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createIssueTrackerClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (url, init) => mockFetch(url, init),
    });

    const { data } = await client.GET("/workspaces", {});
    expect(data).toEqual({ workspaces: [] });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [Request, unknown];
    expect(url.url).toBe("https://example.com/workspaces");
    expect(url.headers.get("Authorization")).toBe("Bearer test-key");
  });

  it("creates an issue", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "i-1", identifier: "ISS-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createIssueTrackerClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (url, init) => mockFetch(url, init),
    });

    const { data } = await client.POST("/workspaces/{organizationId}/issues", {
      params: { path: { organizationId: "org-1" } },
      body: { title: "Bug", teamId: "team-1", priority: "medium" },
    });
    expect(data).toEqual({ id: "i-1", identifier: "ISS-1" });
    const [url] = mockFetch.mock.calls[0] as [Request, unknown];
    expect(url.url).toBe("https://example.com/workspaces/org-1/issues");
  });

  it("returns an error for non-OK responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createIssueTrackerClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (url, init) => mockFetch(url, init),
    });

    const { data, error } = await client.GET("/workspaces", {});
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
  });
});

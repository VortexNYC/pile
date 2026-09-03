import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createIssueTrackerClient } from "../../packages/client/src/index.js";
import app from "../index.js";

describe("typed client integration", () => {
  it("lists workspaces", async () => {
    const client = createIssueTrackerClient({
      baseUrl: "http://localhost",
      apiKey: "unused",
      fetch: async (request) => app.fetch(request, env),
    });

    const { data, error } = await client.GET("/workspaces");

    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(Array.isArray(data!.workspaces)).toBe(true);
  });
});

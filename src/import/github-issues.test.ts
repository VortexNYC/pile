import { describe, expect, it } from "vitest";

import { seedImportContext } from "../test/import-fixtures.js";
import { githubIssuesImportSource } from "./github-issues.js";

describe("github-issues import", () => {
  it("suppresses directed notifications on created and updated issues", async () => {
    const { ctx, issueWrites } = await seedImportContext("github-issues");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith("https://api.github.com")) {
        return originalFetch(input, init);
      }
      const path = new URL(url).pathname;
      if (path === "/repos/acme/widgets") {
        return Response.json({ id: 1, full_name: "acme/widgets" });
      }
      if (path === "/repos/acme/widgets/issues") {
        return Response.json([
          {
            number: 42,
            title: "GitHub issue title",
            body: "GitHub issue body",
            state: "open",
            state_reason: null,
            user: { login: "gh-user-1" },
            assignee: null,
            milestone: null,
            labels: [{ name: "bug" }],
          },
        ]);
      }
      return new Response("Not Found", { status: 404 });
    };

    try {
      const credentials = { token: "gh-token" };
      const options = {
        owner: "acme",
        repo: "widgets",
        state: "open" as const,
      };

      const first = await githubIssuesImportSource.run(
        ctx,
        credentials,
        options
      );
      expect(first.counts.created).toBe(1);

      const second = await githubIssuesImportSource.run(
        ctx,
        credentials,
        options
      );
      expect(second.counts.updated).toBe(1);

      expect(issueWrites).toEqual([
        { method: "createIssue", options: { notify: false } },
        { method: "updateIssue", options: { notify: false } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

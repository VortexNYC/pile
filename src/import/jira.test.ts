import { describe, expect, it } from "vitest";

import { seedImportContext } from "../test/import-fixtures.js";
import { jiraImportSource } from "./jira.js";

const JIRA_HOST = "https://jira-test.example.com";

function jiraIssue(id: string, key: string, parentId?: string) {
  return {
    id,
    key,
    fields: {
      summary: `Jira issue ${key}`,
      description: null,
      status: {
        id: "1",
        name: "In Progress",
        statusCategory: { key: "indeterminate", name: "In Progress" },
      },
      priority: { name: "High" },
      assignee: null,
      reporter: { accountId: "jira-me" },
      labels: [],
      issuetype: { name: "Story" },
      created: "2026-01-01T00:00:00.000+0000",
      updated: "2026-01-02T00:00:00.000+0000",
      comment: { comments: [] },
      attachment: [],
      project: { id: "1", key: "TEST", name: "Test Project" },
      ...(parentId ? { parent: { id: parentId } } : {}),
    },
  };
}

describe("jira import", () => {
  // Seeding a workspace + cold-starting the DO (54 migrations) plus a
  // full importer pass takes ~8s on a loaded runner — well past the 5s
  // default timeout.
  it(
    "suppresses directed notifications on created and parent-linked issues",
    { timeout: 30_000 },
    async () => {
      const { ctx, issueWrites } = await seedImportContext("jira");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (!url.startsWith(JIRA_HOST)) return originalFetch(input, init);
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";

        if (method === "GET" && path === "/rest/api/3/myself") {
          return Response.json({
            accountId: "jira-me",
            emailAddress: "me@example.com",
            displayName: "Me",
          });
        }

        if (method === "POST" && path === "/rest/api/3/search/jql") {
          return Response.json({
            issues: [
              jiraIssue("10000", "TEST-1"),
              jiraIssue("10001", "TEST-2", "10000"),
            ],
          });
        }

        return new Response("Not Found", { status: 404 });
      };

      try {
        const result = await jiraImportSource.run(
          ctx,
          {
            host: JIRA_HOST,
            email: "me@example.com",
            token: "secret",
          },
          { projectKey: "TEST" }
        );
        expect(result.counts.issues).toBe(2);
        expect(result.counts.parentLinks).toBe(1);

        expect(issueWrites).toEqual([
          { method: "createIssue", options: { notify: false } },
          { method: "createIssue", options: { notify: false } },
          { method: "updateIssue", options: { notify: false } },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

import { describe, expect, it } from "vitest";

import { seedImportContext } from "../test/import-fixtures.js";
import { notionImportSource } from "./notion.js";

describe("notion import", () => {
  it("suppresses directed notifications on created and updated issues", async () => {
    const { ctx, issueWrites } = await seedImportContext("notion");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith("https://api.notion.com/v1")) {
        return originalFetch(input, init);
      }
      const path = url.replace("https://api.notion.com/v1", "");
      const method = init?.method ?? "GET";

      if (method === "GET" && path === "/users/me") {
        return Response.json({
          object: "user",
          id: "bot-1",
          type: "bot",
          bot: {
            owner: { type: "workspace", workspace: true },
            workspace_name: "Test Notion",
            workspace_id: "ws-1",
          },
        });
      }

      if (method === "GET" && path === "/databases/db-1") {
        return Response.json({
          object: "database",
          id: "db-1",
          properties: {
            Name: { type: "title" },
            Status: { type: "select" },
          },
        });
      }

      if (method === "POST" && path === "/databases/db-1/query") {
        return Response.json({
          object: "list",
          results: [
            {
              object: "page",
              id: "issue-row-1",
              url: "https://www.notion.so/issue-row-1",
              properties: {
                Name: {
                  type: "title",
                  title: [{ plain_text: "Database Issue One" }],
                },
              },
              parent: { type: "database_id", database_id: "db-1" },
              created_by: { id: "notion-user-1" },
              last_edited_by: { id: "notion-user-1" },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }

      if (method === "GET" && path === "/pages/issue-row-1/markdown") {
        return Response.json({
          object: "page_markdown",
          id: "issue-row-1",
          markdown: "# Database Issue One\n\nDetails from Notion.",
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      const credentials = { token: "ntn-test" };
      const options = { databaseId: "db-1" };

      const first = await notionImportSource.run(ctx, credentials, options);
      expect(first.counts.created).toBe(1);

      const second = await notionImportSource.run(ctx, credentials, options);
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

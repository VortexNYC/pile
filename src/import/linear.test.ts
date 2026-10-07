import { describe, expect, it } from "vitest";

import { seedImportContext } from "../test/import-fixtures.js";
import { linearImportSource } from "./linear.js";

function linearIssue(id: string, identifier: string, parentId?: string) {
  return {
    id,
    identifier,
    title: `Linear issue ${identifier}`,
    description: "Linear body",
    state: { id: "state-1", name: "In Progress", type: "started" },
    priority: 2,
    estimate: null,
    assignee: { id: "linear-user-1" },
    project: null,
    cycle: null,
    labels: { nodes: [{ id: "label-1" }] },
    comments: { nodes: [] },
    attachments: { nodes: [] },
    history: { nodes: [] },
    subscribers: { nodes: [] },
    parent: parentId ? { id: parentId } : null,
    children: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    createdAt: "2026-01-01T00:00:00.000+0000",
    updatedAt: "2026-01-02T00:00:00.000+0000",
  };
}

describe("linear import", () => {
  it("suppresses directed notifications on created and parent-linked issues", async () => {
    const { ctx, issueWrites } = await seedImportContext("linear");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith("https://api.linear.app/graphql")) {
        return originalFetch(input, init);
      }

      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const query: string = body.query ?? "";

      if (query.includes("GetStates")) {
        return Response.json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "state-1", name: "In Progress", type: "started" },
                ],
              },
            },
          },
        });
      }

      if (query.includes("GetLabels")) {
        return Response.json({
          data: {
            issueLabels: {
              nodes: [{ id: "label-1", name: "Bug", color: "#ff0000" }],
            },
          },
        });
      }

      if (query.includes("GetProjects")) {
        return Response.json({
          data: { team: { projects: { nodes: [] } } },
        });
      }

      if (query.includes("GetCycles")) {
        return Response.json({
          data: { team: { cycles: { nodes: [] } } },
        });
      }

      if (query.includes("GetUsers")) {
        return Response.json({
          data: {
            team: {
              members: {
                nodes: [
                  {
                    id: "linear-user-1",
                    name: "Alice",
                    email: "alice@example.com",
                  },
                ],
              },
            },
          },
        });
      }

      if (query.includes("GetTemplates")) {
        return Response.json({
          data: { team: { templates: { nodes: [] } } },
        });
      }

      if (query.includes("GetIssues")) {
        return Response.json({
          data: {
            team: {
              issues: {
                nodes: [
                  linearIssue("linear-issue-1", "VOR-1"),
                  linearIssue("linear-issue-2", "VOR-2", "linear-issue-1"),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      const result = await linearImportSource.run(
        ctx,
        { token: "linear-token" },
        { linearTeamId: "linear-team-1" }
      );
      expect(result.counts.issues).toBe(2);

      const created = issueWrites.filter((c) => c.method === "createIssue");
      const updated = issueWrites.filter((c) => c.method === "updateIssue");
      expect(created).toHaveLength(2);
      expect(updated).toHaveLength(1);
      for (const call of issueWrites) {
        expect(call.options).toEqual({ notify: false });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

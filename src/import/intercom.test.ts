import { describe, expect, it } from "vitest";

import { seedImportContext } from "../test/import-fixtures.js";
import { intercomImportSource } from "./intercom.js";

describe("intercom import", () => {
  it("suppresses directed notifications on created and updated issues", async () => {
    const { ctx, issueWrites } = await seedImportContext("intercom");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.startsWith("https://api.intercom.io")) {
        return originalFetch(input, init);
      }
      const path = new URL(url).pathname;
      if (path === "/conversations") {
        return Response.json({
          type: "conversation.list",
          conversations: [
            {
              type: "conversation",
              id: "conv-1",
              title: "Intercom conversation",
              created_at: 1735689600,
              updated_at: 1735776000,
              state: "open",
              priority: "high",
              source: {
                type: "conversation",
                subject: "Need help",
                body: "<p>Customer body</p>",
              },
            },
          ],
          pages: null,
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    try {
      const credentials = { token: "intercom-token" };

      const options = { state: "all" as const };
      const first = await intercomImportSource.run(ctx, credentials, options);
      expect(first.counts.created).toBe(1);

      const second = await intercomImportSource.run(ctx, credentials, options);
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

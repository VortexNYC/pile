import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { blocksToMarkdown } from "../workspace/blocks.js";
import { getWorkspaceStub } from "./stub.js";

// Public docs site: a document space with publicSharing=true publishes
// markdown at /docs/{org}/{space}/... — llms.txt index + one page per doc.
// No auth: published docs are public by definition.

const indexRoute = createRoute({
  method: "get",
  path: "/docs/{organizationId}/{spaceId}/llms.txt",
  tags: ["docs-site"],
  request: {
    params: z.object({ organizationId: z.string(), spaceId: z.string() }),
  },
  responses: {
    200: {
      description: "llms.txt index of published documents in the space",
      content: { "text/plain": { schema: z.string() } },
    },
    404: { description: "Space not found or not public" },
  },
});

const pageRoute = createRoute({
  method: "get",
  path: "/docs/{organizationId}/{spaceId}/{slug}",
  tags: ["docs-site"],
  request: {
    params: z.object({
      organizationId: z.string(),
      spaceId: z.string(),
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Document content as markdown",
      content: { "text/markdown": { schema: z.string() } },
    },
    404: { description: "Document not found or not published" },
  },
});

export function registerDocsSiteRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(indexRoute, async (c) => {
    const { organizationId, spaceId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const space = await stub.getDocumentSpace(spaceId);
    if (!space || !space.publicSharing) {
      return c.text("Not found", 404);
    }
    const docs = await stub.listDocuments({ spaceId });
    const lines = [
      `# ${space.name}`,
      "",
      space.description ?? "",
      "",
      "## Docs",
      "",
      ...docs.map(
        (d) =>
          `- [${d.title}](/docs/${organizationId}/${spaceId}/${d.slug ?? d.id})`
      ),
      "",
    ];
    return c.text(lines.join("\n"));
  });

  app.openapi(pageRoute, async (c) => {
    const { organizationId, spaceId, slug } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const space = await stub.getDocumentSpace(spaceId);
    if (!space || !space.publicSharing) {
      return c.text("Not found", 404);
    }
    const bySlug = await stub.listDocuments({ spaceId, slug });
    const doc = bySlug[0] ?? (await stub.getDocument(slug));
    if (!doc || doc.spaceId !== spaceId || doc.trashedAt) {
      return c.text("Not found", 404);
    }
    const body =
      doc.contentFormat === "markdown"
        ? doc.content
        : blocksToMarkdown(doc.content);
    return c.text(`# ${doc.title}\n\n${body}\n`);
  });
}

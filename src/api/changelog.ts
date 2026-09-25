import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  createChangelogEntry,
  deleteChangelogEntry,
  getChangelogEntryWithLinks,
  listChangelogEntries,
  notifyVotersOfChangelogEntry,
  setChangelogPublished,
  updateChangelogEntry,
} from "../global/changelog.js";
import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { publicRateLimit } from "../platform/rate-limit.js";
import { rls } from "../platform/rls.js";

const orgParam = z.object({ organizationId: z.string() });
const entryIdParam = z.object({
  organizationId: z.string(),
  entryId: z.string(),
});

const linkSchema = z
  .object({
    ticketId: z.string().optional(),
    issueId: z.string().optional(),
  })
  .refine((l) => l.ticketId !== undefined || l.issueId !== undefined, {
    message: "ticketId or issueId is required",
  });

const changelogLinkSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  ticketId: z.string().nullable(),
  issueId: z.string().nullable(),
});

const changelogEntrySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.string(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  links: z.array(changelogLinkSchema),
});

const createEntryBodySchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  labels: z.array(z.string().max(50)).max(10).optional(),
  links: z.array(linkSchema).max(100).optional(),
  publish: z.boolean().optional(),
});

const updateEntryBodySchema = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20_000).optional(),
  labels: z.array(z.string().max(50)).max(10).optional(),
  links: z.array(linkSchema).max(100).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  includeDrafts: z.coerce.boolean().default(false),
});

function entryNotFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Changelog entry not found",
  });
}

const createEntryRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/changelog",
  tags: ["changelog"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createEntryBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Changelog entry created",
      content: {
        "application/json": {
          schema: z.object({ entry: changelogEntrySchema }),
        },
      },
    },
  },
});

const listEntriesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/changelog",
  tags: ["changelog"],
  middleware: [publicRateLimit({ bucket: "changelog", max: 120 })],
  request: {
    params: orgParam,
    query: listQuerySchema,
  },
  responses: {
    200: {
      description:
        "Published changelog entries — anonymous public read. Drafts require a workspace token (includeDrafts).",
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(changelogEntrySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const getEntryRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/changelog/{entryId}",
  tags: ["changelog"],
  middleware: [rls("read")],
  request: { params: entryIdParam },
  responses: {
    200: {
      description: "Changelog entry",
      content: {
        "application/json": {
          schema: z.object({ entry: changelogEntrySchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const updateEntryRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/changelog/{entryId}",
  tags: ["changelog"],
  middleware: [rls("write")],
  request: {
    params: entryIdParam,
    body: {
      content: { "application/json": { schema: updateEntryBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Changelog entry updated",
      content: {
        "application/json": {
          schema: z.object({ entry: changelogEntrySchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/changelog/{entryId}",
  tags: ["changelog"],
  middleware: [rls("write")],
  request: { params: entryIdParam },
  responses: {
    200: {
      description: "Changelog entry deleted",
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
    },
  },
});

const publishEntryRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/changelog/{entryId}/publish",
  tags: ["changelog"],
  middleware: [rls("write")],
  request: { params: entryIdParam },
  responses: {
    200: {
      description:
        "Entry published — notifies voters on linked tickets (opt-outs honored)",
      content: {
        "application/json": {
          schema: z.object({
            entry: changelogEntrySchema,
            notified: z.array(z.string()),
          }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const unpublishEntryRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/changelog/{entryId}/unpublish",
  tags: ["changelog"],
  middleware: [rls("write")],
  request: { params: entryIdParam },
  responses: {
    200: {
      description: "Entry unpublished",
      content: {
        "application/json": {
          schema: z.object({ entry: changelogEntrySchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function registerChangelogRoutes(app: OpenAPIHono<AppContext>) {
  // RSS feed — plain Hono route, not OpenAPI (XML body, not JSON).
  app.get("/workspaces/:organizationId/changelog.rss", async (c) => {
    const organizationId = c.req.param("organizationId");
    const db = createD1(c.env.D1);
    const { entries } = await listChangelogEntries(db, organizationId, {
      publishedOnly: true,
      limit: 50,
    });
    const base = (c.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");
    const items = entries
      .map(
        (e) => `    <item>
      <title>${escapeXml(e.title)}</title>
      <link>${base}/workspaces/${organizationId}/changelog</link>
      <guid>${e.id}</guid>
      <pubDate>${new Date(e.publishedAt!).toUTCString()}</pubDate>
      <description>${escapeXml(e.body.slice(0, 500))}</description>
    </item>`
      )
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Changelog</title>
    <link>${base}/workspaces/${organizationId}/changelog</link>
    <description>Shipped updates</description>
${items}
  </channel>
</rss>`;
    return c.body(xml, 200, { "Content-Type": "application/rss+xml" });
  });

  app.openapi(listEntriesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    // Drafts are staff-only; anonymous requests always get published only.
    const authed = Boolean(c.get("workspaceIdentity"));
    const publishedOnly = !(authed && query.includeDrafts);
    const { entries, nextCursor } = await listChangelogEntries(
      db,
      organizationId,
      { publishedOnly, limit: query.limit, cursor: query.cursor }
    );
    return c.json({ entries, nextCursor });
  });

  app.openapi(createEntryRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const entry = await createChangelogEntry(db, organizationId, body);
    return c.json({ entry }, 201);
  });

  app.openapi(getEntryRoute, async (c) => {
    const { organizationId, entryId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const entry = await getChangelogEntryWithLinks(db, organizationId, entryId);
    if (!entry) entryNotFound();
    return c.json({ entry });
  });

  app.openapi(updateEntryRoute, async (c) => {
    const { organizationId, entryId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const entry = await updateChangelogEntry(db, organizationId, entryId, body);
    if (!entry) entryNotFound();
    return c.json({ entry });
  });

  app.openapi(deleteEntryRoute, async (c) => {
    const { organizationId, entryId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const deleted = await deleteChangelogEntry(db, organizationId, entryId);
    return c.json({ deleted });
  });

  app.openapi(publishEntryRoute, async (c) => {
    const { organizationId, entryId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const entry = await setChangelogPublished(
      db,
      organizationId,
      entryId,
      true
    );
    if (!entry) entryNotFound();
    const notified = await notifyVotersOfChangelogEntry(
      db,
      c.env,
      organizationId,
      entry
    );
    return c.json({ entry, notified });
  });

  app.openapi(unpublishEntryRoute, async (c) => {
    const { organizationId, entryId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const entry = await setChangelogPublished(
      db,
      organizationId,
      entryId,
      false
    );
    if (!entry) entryNotFound();
    return c.json({ entry });
  });
}

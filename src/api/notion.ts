import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { notionPageMappings } from "../global/schema.js";
import {
  getNotionPage,
  getNotionPageMarkdown,
  getNotionWorkspaceInfo,
  NotionApiError,
  searchNotionPages,
  type NotionSearchPage,
} from "../global/notion-client.js";
import { upsertNotionInstallation } from "../global/notion-installations.js";
import { findNotionPageMapping, upsertNotionPageMapping } from "../global/notion-page-mappings.js";
import {
  createNotionUserMapping,
  findNotionUserByNotionId,
  listNotionUsers,
} from "../global/notion-users.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const notionUserSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  notionUserId: z.string(),
  createdAt: z.string(),
});

const notionUserRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/notion/users",
  tags: ["notion"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string(),
            notionUserId: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Notion user mapping created",
      content: { "application/json": { schema: notionUserSchema } },
    },
  },
});

const notionUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/notion/users",
  tags: ["notion"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Notion user mappings",
      content: {
        "application/json": {
          schema: z.object({ users: z.array(notionUserSchema) }),
        },
      },
    },
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/notion/import",
  tags: ["notion"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().min(1),
            rootPageId: z.string().optional(),
            spaceId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Import summary",
      content: {
        "application/json": {
          schema: z.object({
            created: z.number().int(),
            updated: z.number().int(),
            errors: z.number().int(),
            workspaceId: z.string(),
            workspaceName: z.string().nullable(),
          }),
        },
      },
    },
  },
});

async function resolveUserId(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  notionUserId: string | null,
  fallbackUserId: string
) {
  if (!notionUserId) return fallbackUserId;
  const mapping = await findNotionUserByNotionId(
    db,
    organizationId,
    notionUserId
  );
  return mapping?.userId ?? fallbackUserId;
}

async function importNotionPage(
  c: {
    env: AppContext["Bindings"];
  },
  db: ReturnType<typeof createD1>,
  organizationId: string,
  token: string,
  notionPage: NotionSearchPage,
  importerId: string,
  spaceId: string | null,
  parentDocumentId: string | null
) {
  const stub = getWorkspaceStub(c.env, organizationId);

  const [page, markdown] = await Promise.all([
    getNotionPage(token, notionPage.id),
    getNotionPageMarkdown(token, notionPage.id),
  ]);

  const actorId = await resolveUserId(
    db,
    organizationId,
    page.lastEditedById ?? page.createdById,
    importerId
  );

  const mapping = await findNotionPageMapping(
    db,
    organizationId,
    notionPage.id
  );

  let documentId: string;
  if (mapping) {
    const updated = await stub.updateDocument(
      mapping.documentId,
      {
        title: page.title,
        icon: page.icon,
        content: markdown,
        contentFormat: "markdown",
        parentDocumentId,
        spaceId,
      },
      actorId
    );
    if (!updated) {
      throw new Error("Failed to update document");
    }
    documentId = updated.id;
  } else {
    const createdById = await resolveUserId(
      db,
      organizationId,
      page.createdById,
      importerId
    );
    const created = await stub.createDocument({
      title: page.title,
      icon: page.icon,
      content: markdown,
      contentFormat: "markdown",
      parentDocumentId,
      spaceId,
      createdById,
    });
    documentId = created.id;
  }

  await upsertNotionPageMapping(db, organizationId, notionPage.id, documentId);

  return mapping ? "updated" : "created";
}

export function registerNotionRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(notionUserRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { userId, notionUserId } = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await findNotionUserByNotionId(
      db,
      organizationId,
      notionUserId
    );
    if (existing) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "Notion user already mapped",
      });
    }

    const mapping = await createNotionUserMapping(
      db,
      organizationId,
      userId,
      notionUserId
    );
    return c.json(mapping, 201);
  });

  app.openapi(notionUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const users = await listNotionUsers(db, organizationId);
    return c.json({ users });
  });

  app.openapi(importRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { token, rootPageId, spaceId } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);

    let workspaceInfo;
    try {
      workspaceInfo = await getNotionWorkspaceInfo(token);
    } catch (err) {
      if (err instanceof NotionApiError) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: err.status,
          message: err.message,
        });
      }
      throw err;
    }

    await upsertNotionInstallation(
      db,
      organizationId,
      workspaceInfo.workspaceId,
      token
    );

    const pages: NotionSearchPage[] = [];

    if (rootPageId) {
      const page = await getNotionPage(token, rootPageId);
      pages.push({
        id: page.id,
        url: page.url,
        icon: page.icon,
        title: page.title,
        parentType: page.parentType,
        parentPageId: page.parentPageId,
      });
    } else {
      let cursor: string | null = null;
      do {
        const result = await searchNotionPages(token, cursor ?? undefined);
        pages.push(...result.pages);
        cursor = result.nextCursor;
      } while (cursor);
    }

    const parentByPageId = new Map<string, string | null>();

    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const page of pages) {
      try {
        const result = await importNotionPage(
          c,
          db,
          organizationId,
          token,
          page,
          identity.id,
          spaceId ?? null,
          null
        );
        if (result === "created") created++;
        else updated++;
        parentByPageId.set(page.id, page.parentPageId);
      } catch {
        errors++;
      }
    }

    const mappings = await db
      .select()
      .from(notionPageMappings)
      .where(eq(notionPageMappings.organizationId, organizationId))
      .all();
    const documentIdByNotionPageId = new Map(
      mappings.map((m) => [m.notionPageId, m.documentId])
    );

    for (const page of pages) {
      const documentId = documentIdByNotionPageId.get(page.id);
      const parentPageId = parentByPageId.get(page.id);
      if (!documentId || !parentPageId) continue;
      const parentDocumentId = documentIdByNotionPageId.get(parentPageId);
      if (!parentDocumentId) continue;
      try {
        const stub = getWorkspaceStub(c.env, organizationId);
        await stub.updateDocument(
          documentId,
          { parentDocumentId },
          identity.id
        );
      } catch {
        errors++;
      }
    }

    return c.json({
      created,
      updated,
      errors,
      workspaceId: workspaceInfo.workspaceId,
      workspaceName: workspaceInfo.workspaceName,
    });
  });
}

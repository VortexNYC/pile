import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { releases } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const now = () => new Date().toISOString();

const releaseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string().nullable(),
  teamId: z.string().nullable(),
  name: z.string(),
  version: z.string().nullable(),
  status: z.enum(["upcoming", "in_progress", "released", "archived"]),
  notes: z.string().nullable(),
  plannedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const releaseBodySchema = z.object({
  projectId: z.string().optional(),
  teamId: z.string().optional(),
  name: z.string().min(1),
  version: z.string().optional(),
  status: z
    .enum(["upcoming", "in_progress", "released", "archived"])
    .default("upcoming"),
  notes: z.string().optional(),
  plannedAt: z.string().optional(),
  releasedAt: z.string().optional(),
});

const listReleasesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/releases",
  tags: ["releases"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      projectId: z.string().optional(),
      teamId: z.string().optional(),
      status: z
        .enum(["upcoming", "in_progress", "released", "archived"])
        .optional(),
    }),
  },
  responses: {
    200: {
      description: "Releases list",
      content: {
        "application/json": {
          schema: z.object({ releases: z.array(releaseSchema) }),
        },
      },
    },
  },
});

const createReleaseRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/releases",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: releaseBodySchema } } },
  },
  responses: {
    201: {
      description: "Release created",
      content: { "application/json": { schema: releaseSchema } },
    },
  },
});

const getReleaseRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/releases/{id}",
  tags: ["releases"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Release",
      content: { "application/json": { schema: releaseSchema } },
    },
  },
});

const updateReleaseRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/releases/{id}",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: { "application/json": { schema: releaseBodySchema.partial() } },
    },
  },
  responses: {
    200: {
      description: "Release updated",
      content: { "application/json": { schema: releaseSchema } },
    },
  },
});

const deleteReleaseRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/releases/{id}",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: { 204: { description: "Release deleted" } },
});

function toReleaseResponse(row: typeof releases.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    teamId: row.teamId,
    name: row.name,
    version: row.version,
    status: row.status,
    notes: row.notes,
    plannedAt: row.plannedAt,
    releasedAt: row.releasedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerReleaseRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listReleasesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const conditions = [eq(releases.organizationId, organizationId)];
    if (query.projectId)
      conditions.push(eq(releases.projectId, query.projectId));
    if (query.teamId) conditions.push(eq(releases.teamId, query.teamId));
    if (query.status) conditions.push(eq(releases.status, query.status));
    const rows = await db
      .select()
      .from(releases)
      .where(and(...conditions))
      .all();
    return c.json({ releases: rows.map(toReleaseResponse) });
  });

  app.openapi(createReleaseRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const id = crypto.randomUUID();
    const ts = now();
    await db.insert(releases).values({
      id,
      organizationId,
      projectId: input.projectId ?? null,
      teamId: input.teamId ?? null,
      name: input.name,
      version: input.version ?? null,
      status: input.status,
      notes: input.notes ?? null,
      plannedAt: input.plannedAt ?? null,
      releasedAt: input.releasedAt ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    const row = await db
      .select()
      .from(releases)
      .where(eq(releases.id, id))
      .get();
    return c.json(toReleaseResponse(row!), 201);
  });

  app.openapi(getReleaseRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db
      .select()
      .from(releases)
      .where(
        and(eq(releases.id, id), eq(releases.organizationId, organizationId))
      )
      .get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Release not found",
      });
    }
    return c.json(toReleaseResponse(row));
  });

  app.openapi(updateReleaseRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    await db
      .update(releases)
      .set({
        ...input,
        projectId: input.projectId ?? undefined,
        teamId: input.teamId ?? undefined,
        version: input.version ?? undefined,
        notes: input.notes ?? undefined,
        plannedAt: input.plannedAt ?? undefined,
        releasedAt: input.releasedAt ?? undefined,
        updatedAt: now(),
      })
      .where(
        and(eq(releases.id, id), eq(releases.organizationId, organizationId))
      );
    const row = await db
      .select()
      .from(releases)
      .where(
        and(eq(releases.id, id), eq(releases.organizationId, organizationId))
      )
      .get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Release not found",
      });
    }
    return c.json(toReleaseResponse(row));
  });

  app.openapi(deleteReleaseRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await db
      .delete(releases)
      .where(
        and(eq(releases.id, id), eq(releases.organizationId, organizationId))
      );
    return c.body(null, 204);
  });
}

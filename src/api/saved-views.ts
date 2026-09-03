import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  updateSavedView,
  type SavedViewRecord,
} from "../global/saved-views.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import {
  filterConditionSchema,
  type FilterCondition,
} from "../workspace/filter.js";

const savedViewSortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]).optional(),
});

const savedViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  filter: z.unknown(),
  search: z.string().nullable(),
  sort: savedViewSortSchema.nullable(),
  columns: z.array(z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function parseSavedViewFilter(value: string): FilterCondition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Filter must be valid JSON",
    });
  }
  return filterConditionSchema.parse(parsed);
}

function parseSavedViewSort(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Sort must be valid JSON",
    });
  }
  return savedViewSortSchema.parse(parsed);
}

function parseSavedViewColumns(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Columns must be valid JSON",
    });
  }
  return z.array(z.string()).parse(parsed);
}

function serializeSavedView(record: SavedViewRecord) {
  const filter = parseSavedViewFilter(record.filter);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    ownerId: record.ownerId,
    name: record.name,
    filter,
    search: record.search,
    sort: record.sort ? parseSavedViewSort(record.sort) : null,
    columns: record.columns ? parseSavedViewColumns(record.columns) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unknownToFilter(value: unknown): FilterCondition {
  return filterConditionSchema.parse(value);
}

const createSavedViewBodySchema = z.object({
  name: z.string().min(1),
  filter: z.unknown(),
  search: z.string().optional(),
  sort: savedViewSortSchema.optional(),
  columns: z.array(z.string()).optional(),
});

const updateSavedViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  filter: z.unknown().optional(),
  search: z.string().optional(),
  sort: savedViewSortSchema.optional().nullable(),
  columns: z.array(z.string()).optional().nullable(),
});

const listSavedViewsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/saved-views",
  tags: ["saved-views"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Saved views list",
      content: {
        "application/json": {
          schema: z.object({ views: z.array(savedViewSchema) }),
        },
      },
    },
  },
});

const createSavedViewRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/saved-views",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createSavedViewBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Saved view created",
      content: {
        "application/json": { schema: savedViewSchema },
      },
    },
  },
});

const getSavedViewRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Saved view",
      content: {
        "application/json": { schema: savedViewSchema },
      },
    },
    404: { description: "Saved view not found" },
  },
});

const updateSavedViewRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: updateSavedViewBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Saved view updated",
      content: {
        "application/json": { schema: savedViewSchema },
      },
    },
    404: { description: "Saved view not found" },
  },
});

const deleteSavedViewRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Saved view deleted" },
  },
});

function getIdentity(c: {
  var: Pick<AppContext["Variables"], "workspaceIdentity">;
}) {
  return c.var.workspaceIdentity;
}

export function registerSavedViewRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listSavedViewsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const records = await listSavedViews(db, workspaceId);
    return c.json({ views: records.map(serializeSavedView) });
  });

  app.openapi(createSavedViewRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = getIdentity(c);
    const db = createD1(c.env.D1);
    const record = await createSavedView(db, {
      workspaceId,
      ownerId: identity.id,
      name: body.name,
      filter: unknownToFilter(body.filter),
      search: body.search,
      sort: body.sort,
      columns: body.columns,
    });
    return c.json(serializeSavedView(record), 201);
  });

  app.openapi(getSavedViewRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const record = await getSavedView(db, id, workspaceId);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    return c.json(serializeSavedView(record));
  });

  app.openapi(updateSavedViewRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = getIdentity(c);
    const db = createD1(c.env.D1);
    const existing = await getSavedView(db, id, workspaceId);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    if (
      existing.ownerId !== identity.id &&
      !identity.permissions.includes("admin")
    ) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot modify another user's saved view",
      });
    }
    const record = await updateSavedView(db, id, workspaceId, {
      name: body.name,
      filter:
        body.filter === undefined ? undefined : unknownToFilter(body.filter),
      search: body.search,
      sort: body.sort,
      columns: body.columns,
    });
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    return c.json(serializeSavedView(record));
  });

  app.openapi(deleteSavedViewRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const identity = getIdentity(c);
    const db = createD1(c.env.D1);
    const existing = await getSavedView(db, id, workspaceId);
    if (!existing) {
      return c.body(null, 204);
    }
    if (
      existing.ownerId !== identity.id &&
      !identity.permissions.includes("admin")
    ) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot delete another user's saved view",
      });
    }
    await deleteSavedView(db, id, workspaceId);
    return c.body(null, 204);
  });
}

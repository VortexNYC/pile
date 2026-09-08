import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { getWorkspaceStub } from "./stub.js";
import type { SavedViewRecord } from "../workspace/data.js";
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
  organizationId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  shared: z.boolean(),
  isFavorite: z.boolean().optional(),
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

function serializeSavedView(record: SavedViewRecord, isFavorite?: boolean) {
  const filter = parseSavedViewFilter(record.filter);
  return {
    id: record.id,
    organizationId: record.organizationId,
    ownerId: record.ownerId,
    name: record.name,
    shared: record.shared,
    filter,
    search: record.search,
    sort: record.sort ? parseSavedViewSort(record.sort) : null,
    columns: record.columns ? parseSavedViewColumns(record.columns) : null,
    ...(isFavorite === undefined ? {} : { isFavorite }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unknownToFilter(value: unknown): FilterCondition {
  return filterConditionSchema.parse(value);
}

const createSavedViewBodySchema = z.object({
  name: z.string().min(1),
  shared: z.boolean().optional(),
  filter: z.unknown(),
  search: z.string().optional(),
  sort: savedViewSortSchema.optional(),
  columns: z.array(z.string()).optional(),
});

const updateSavedViewBodySchema = z.object({
  name: z.string().min(1).optional(),
  shared: z.boolean().optional(),
  filter: z.unknown().optional(),
  search: z.string().optional(),
  sort: savedViewSortSchema.optional().nullable(),
  columns: z.array(z.string()).optional().nullable(),
});

const listSavedViewsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/saved-views",
  tags: ["saved-views"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/saved-views",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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

const favoriteRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/saved-views/{id}/favorite",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "View favorited",
      content: {
        "application/json": { schema: savedViewSchema },
      },
    },
    404: { description: "Saved view not found" },
  },
});

const unfavoriteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/saved-views/{id}/favorite",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "View unfavorited" },
    404: { description: "Saved view not found" },
  },
});

const viewPreferencesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/me/view-preferences",
  tags: ["saved-views"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Per-user view preferences",
      content: {
        "application/json": {
          schema: z.object({ defaultViewId: z.string().nullable() }),
        },
      },
    },
  },
});

const updateViewPreferencesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/me/view-preferences",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ defaultViewId: z.string().nullable() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "View preferences updated",
      content: {
        "application/json": {
          schema: z.object({ defaultViewId: z.string().nullable() }),
        },
      },
    },
    404: { description: "Saved view not found" },
  },
});

const deleteSavedViewRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/saved-views/{id}",
  tags: ["saved-views"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Saved view deleted" },
  },
});

function assertViewAccess(
  record: SavedViewRecord,
  identity: { id: string; permissions: string[] }
) {
  if (
    record.ownerId !== identity.id &&
    !record.shared &&
    !identity.permissions.includes("admin")
  ) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Saved view not found",
    });
  }
}

function getIdentity(c: {
  var: Pick<AppContext["Variables"], "workspaceIdentity">;
}) {
  return c.var.workspaceIdentity;
}

export function registerSavedViewRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listSavedViewsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const records = await stub.listSavedViews(identity.id);
    const favorites = new Set(
      (await stub.listFavoriteViewIds(identity.id)).map((row) => row.viewId)
    );
    return c.json({
      views: records.map((record) =>
        serializeSavedView(record, favorites.has(record.id))
      ),
    });
  });

  app.openapi(createSavedViewRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const record = await stub.createSavedView({
      ownerId: identity.id,
      name: body.name,
      shared: body.shared,
      filter: unknownToFilter(body.filter),
      search: body.search,
      sort: body.sort,
      columns: body.columns,
    });
    return c.json(serializeSavedView(record), 201);
  });

  app.openapi(favoriteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const record = await stub.getSavedView(id);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    assertViewAccess(record, identity);
    await stub.favoriteView(id, identity.id);
    return c.json(serializeSavedView(record, true));
  });

  app.openapi(unfavoriteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const record = await stub.getSavedView(id);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    assertViewAccess(record, identity);
    await stub.unfavoriteView(id, identity.id);
    return c.body(null, 204);
  });

  app.openapi(viewPreferencesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const prefs = await stub.getUserViewPreferences(identity.id);
    return c.json({ defaultViewId: prefs?.defaultViewId ?? null });
  });

  app.openapi(updateViewPreferencesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { defaultViewId } = c.req.valid("json");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    if (defaultViewId !== null) {
      const record = await stub.getSavedView(defaultViewId);
      if (!record) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Saved view not found",
        });
      }
      assertViewAccess(record, identity);
    }
    const prefs = await stub.setDefaultView(identity.id, defaultViewId);
    return c.json({ defaultViewId: prefs?.defaultViewId ?? null });
  });

  app.openapi(getSavedViewRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const record = await stub.getSavedView(id);
    if (!record) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Saved view not found",
      });
    }
    assertViewAccess(record, getIdentity(c));
    return c.json(serializeSavedView(record));
  });

  app.openapi(updateSavedViewRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getSavedView(id);
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
    const record = await stub.updateSavedView(id, {
      name: body.name,
      shared: body.shared,
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
    const { organizationId, id } = c.req.valid("param");
    const identity = getIdentity(c);
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getSavedView(id);
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
    await stub.deleteSavedView(id);
    return c.body(null, 204);
  });
}

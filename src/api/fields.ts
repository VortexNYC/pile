import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { FieldType } from "../workspace/data/index.js";
import { getWorkspaceStub } from "./stub.js";

const fieldTypeEnum = z.enum(["text", "number", "select", "date", "boolean"]);

const fieldSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: z.string(),
  name: z.string(),
  type: fieldTypeEnum,
  options: z.array(z.string()).nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const valueSchema = z.object({
  fieldId: z.string(),
  entityId: z.string(),
  organizationId: z.string(),
  value: z.string().nullable(),
  updatedAt: z.string(),
});

const createFieldSchema = z.object({
  entityType: z.string().min(1),
  name: z.string().min(1),
  type: fieldTypeEnum,
  options: z.array(z.string()).optional(),
  position: z.number().int().optional(),
});

const setValueSchema = z.object({
  entityId: z.string(),
  value: z.string().nullable(),
});

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Not found",
  });
}

const orgParam = z.object({ organizationId: z.string() });
const fieldIdParam = z.object({
  organizationId: z.string(),
  fieldId: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/fields",
  tags: ["fields"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: z.object({ entityType: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Field definitions",
      content: {
        "application/json": {
          schema: z.object({ fields: z.array(fieldSchema) }),
        },
      },
    },
  },
});

const createFieldRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/fields",
  tags: ["fields"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: { content: { "application/json": { schema: createFieldSchema } } },
  },
  responses: {
    201: {
      description: "Created field",
      content: {
        "application/json": { schema: z.object({ field: fieldSchema }) },
      },
    },
  },
});

const deleteFieldRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/fields/{fieldId}",
  tags: ["fields"],
  middleware: [rls("write")],
  request: { params: fieldIdParam },
  responses: {
    200: {
      description: "Deleted field",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

const getValuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/fields/values/{entityId}",
  tags: ["fields"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      entityId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Field values for an entity",
      content: {
        "application/json": {
          schema: z.object({ values: z.array(valueSchema) }),
        },
      },
    },
  },
});

const setValueRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/fields/{fieldId}/value",
  tags: ["fields"],
  middleware: [rls("write")],
  request: {
    params: fieldIdParam,
    body: { content: { "application/json": { schema: setValueSchema } } },
  },
  responses: {
    200: {
      description: "Field value set",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

export function registerFieldRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { entityType } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ fields: await stub.listFieldDefinitions(entityType) }, 200);
  });

  app.openapi(createFieldRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const field = await stub.createFieldDefinition({
      entityType: body.entityType,
      name: body.name,
      type: body.type as FieldType,
      options: body.options,
      position: body.position,
    });
    return c.json({ field }, 201);
  });

  app.openapi(deleteFieldRoute, async (c) => {
    const { organizationId, fieldId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteFieldDefinition(fieldId);
    if (!ok) notFound();
    return c.json({ ok }, 200);
  });

  app.openapi(getValuesRoute, async (c) => {
    const { organizationId, entityId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ values: await stub.listFieldValues(entityId) }, 200);
  });

  app.openapi(setValueRoute, async (c) => {
    const { organizationId, fieldId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setFieldValue(fieldId, body.entityId, body.value);
    return c.json({ ok: true }, 200);
  });
}

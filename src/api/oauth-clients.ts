import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { apikey } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const oauthClientSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.string()),
  permissions: z.string(),
  createdAt: z.string(),
});

const oauthClientWithSecretSchema = oauthClientSchema.extend({
  clientId: z.string(),
  clientSecret: z.string(),
});

const oauthClientBodySchema = z.object({
  name: z.string().min(1),
  redirectUris: z.array(z.string().url()).default([]),
  scopes: z.array(z.string()).default([]),
  permissions: z.string().default("read"),
});

const oauthClientUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  redirectUris: z.array(z.string().url()).optional(),
  scopes: z.array(z.string()).optional(),
  permissions: z.string().optional(),
});

const oauthClientMetadataSchema = z.object({
  organizationId: z.string(),
  permissions: z.string(),
  actorType: z.literal("oauth-client"),
  redirectUris: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
});

function parseMetadata(metadata: unknown) {
  if (typeof metadata === "string") {
    return oauthClientMetadataSchema.parse(JSON.parse(metadata));
  }
  return oauthClientMetadataSchema.parse(metadata);
}

const listOAuthClientsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/oauth-clients",
  tags: ["oauth-clients"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "OAuth clients list",
      content: {
        "application/json": {
          schema: z.object({ clients: z.array(oauthClientSchema) }),
        },
      },
    },
  },
});

const createOAuthClientRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/oauth-clients",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: oauthClientBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "OAuth client created",
      content: {
        "application/json": { schema: oauthClientWithSecretSchema },
      },
    },
  },
});

const getOAuthClientRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "OAuth client",
      content: {
        "application/json": { schema: oauthClientSchema },
      },
    },
    404: { description: "OAuth client not found" },
  },
});

const updateOAuthClientRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: oauthClientUpdateSchema },
      },
    },
  },
  responses: {
    200: {
      description: "OAuth client updated",
      content: {
        "application/json": { schema: oauthClientSchema },
      },
    },
    404: { description: "OAuth client not found" },
  },
});

const deleteOAuthClientRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "OAuth client deleted" },
  },
});

function toClient(row: typeof apikey.$inferSelect): z.infer<typeof oauthClientSchema> {
  const parsed = parseMetadata(row.metadata);
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt);
  return {
    id: row.id,
    organizationId: parsed.organizationId,
    name: row.name ?? "",
    redirectUris: parsed.redirectUris,
    scopes: parsed.scopes,
    permissions: parsed.permissions,
    createdAt,
  };
}

export function registerOAuthClientRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listOAuthClientsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rows = await db.select().from(apikey).all();
    const clients = rows
      .filter((row) => {
        try {
          const parsed = parseMetadata(row.metadata);
          return parsed.organizationId === organizationId;
        } catch {
          return false;
        }
      })
      .map(toClient);
    return c.json({ clients });
  });

  app.openapi(createOAuthClientRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const auth = createAuth(c.env);

    const result = await auth.api.createApiKey({
      body: {
        userId: identity.id,
        name: input.name,
        metadata: {
          organizationId,
          permissions: input.permissions,
          actorType: "oauth-client",
          redirectUris: input.redirectUris,
          scopes: input.scopes,
        },
      },
    });

    const parsed = z
      .object({
        id: z.string(),
        key: z.string(),
        name: z.string().nullable(),
        createdAt: z.union([z.date(), z.string()]),
      })
      .parse(result);

    return c.json(
      {
        id: parsed.id,
        organizationId,
        name: parsed.name ?? input.name,
        clientId: parsed.id,
        clientSecret: parsed.key,
        redirectUris: input.redirectUris,
        scopes: input.scopes,
        permissions: input.permissions,
        createdAt:
          parsed.createdAt instanceof Date
            ? parsed.createdAt.toISOString()
            : parsed.createdAt,
      },
      201
    );
  });

  app.openapi(getOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const parsed = parseMetadata(row.metadata);
    if (parsed.organizationId !== organizationId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    return c.json(toClient(row));
  });

  app.openapi(updateOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const parsed = parseMetadata(row.metadata);
    if (parsed.organizationId !== organizationId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const next = {
      ...parsed,
      permissions: input.permissions ?? parsed.permissions,
      redirectUris: input.redirectUris ?? parsed.redirectUris,
      scopes: input.scopes ?? parsed.scopes,
    };
    await db
      .update(apikey)
      .set({
        name: input.name ?? row.name,
        metadata: JSON.stringify(next),
      })
      .where(eq(apikey.id, id));
    return c.json(toClient({ ...row, name: input.name ?? row.name, metadata: JSON.stringify(next) }));
  });

  app.openapi(deleteOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (row) {
      const parsed = parseMetadata(row.metadata);
      if (parsed.organizationId === organizationId) {
        await db.delete(apikey).where(eq(apikey.id, id));
      }
    }
    return c.body(null, 204);
  });
}

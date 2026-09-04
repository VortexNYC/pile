import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { apikey, user as userTable } from "../global/schema.js";
import { getWorkspaceById } from "../global/workspaces.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const tokenSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  permissions: z.string(),
  createdAt: z.string(),
});

const tokenWithSecretSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  token: z.string(),
  permissions: z.string(),
  createdAt: z.string(),
});

const tokenBodySchema = z.object({
  name: z.string().min(1),
  permissions: z.string().optional(),
  actorType: z.enum(["user", "agent"]).optional(),
  provider: z.string().optional(),
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Token list",
      content: {
        "application/json": {
          schema: z.object({ tokens: z.array(tokenSchema) }),
        },
      },
    },
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: tokenBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Token created",
      content: {
        "application/json": { schema: tokenWithSecretSchema },
      },
    },
  },
});

const deleteTokenRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/tokens/{id}",
  tags: ["tokens"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Token deleted" },
  },
});

const apiKeyMetadataSchema = z.object({
  workspaceId: z.string(),
  permissions: z.string(),
});

function parseApiKeyMetadata(metadata: string | null | undefined): {
  workspaceId: string;
  permissions: string;
} | null {
  if (!metadata) return null;
  try {
    return apiKeyMetadataSchema.parse(JSON.parse(metadata));
  } catch {
    return null;
  }
}

export function registerTokenRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listTokensRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rows = await db.select().from(apikey).all();
    const tokens = rows
      .map((row) => ({
        row,
        parsed: parseApiKeyMetadata(row.metadata),
      }))
      .filter(({ parsed }) => parsed?.workspaceId === workspaceId)
      .map(({ row, parsed }) => ({
        id: row.id,
        workspaceId: parsed!.workspaceId,
        name: row.name ?? "",
        permissions: parsed!.permissions,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      }));
    return c.json({ tokens });
  });

  app.openapi(createTokenRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);

    const auth = createAuth(c.env);
    const permissions = input.permissions ?? "read";
    const actorType = input.actorType ?? "user";
    let userId = identity.id;

    if (actorType === "agent") {
      const agentId = crypto.randomUUID();
      await db.insert(userTable).values({
        id: agentId,
        name: input.name,
        email: `agent-${agentId}@${workspaceId}.vortex.nyc`,
        emailVerified: true,
        metadata: JSON.stringify({
          type: "agent",
          provider: input.provider ?? "vortex",
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      userId = agentId;
    } else if (identity.type === "agent") {
      const workspace = await getWorkspaceById(db, workspaceId);
      if (!workspace) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Workspace not found",
        });
      }
      userId = workspace.ownerId;
    }

    const result = await auth.api.createApiKey({
      body: {
        userId,
        name: input.name,
        metadata: { workspaceId, permissions, actorType },
      },
    });

    const resultSchema = z.object({
      id: z.string(),
      key: z.string(),
      name: z.string().nullable(),
      createdAt: z.union([z.date(), z.string()]),
    });
    const parsed = resultSchema.parse(result);

    return c.json(
      {
        id: parsed.id,
        workspaceId,
        name: parsed.name ?? input.name,
        token: parsed.key,
        permissions,
        createdAt:
          parsed.createdAt instanceof Date
            ? parsed.createdAt.toISOString()
            : parsed.createdAt,
      },
      201
    );
  });

  app.openapi(deleteTokenRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    const parsed = parseApiKeyMetadata(row?.metadata);
    if (!row || parsed?.workspaceId !== workspaceId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Token not found",
      });
    }
    await db.delete(apikey).where(eq(apikey.id, id));
    return c.body(null, 204);
  });
}

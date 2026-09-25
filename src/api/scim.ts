import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { member } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import {
  requireHumanSession,
  type AppContext,
} from "../platform/middleware.js";
import { emitWorkspaceAudit } from "./audit-emit.js";

const SCIM_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const;

const createSCIMConnectionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/scim/connections",
  tags: ["scim"],
  middleware: [requireHumanSession],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            scopes: z.array(z.enum(SCIM_SCOPES)).min(1).optional(),
            expiresInDays: z.number().int().positive().max(365).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description:
        "SCIM connection created — the bearer token is returned once and is not recoverable later.",
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string(),
            provisioningDomainId: z.string(),
            token: z.string(),
            baseUrl: z.string(),
          }),
        },
      },
    },
    403: { description: "Requires owner or admin role in the workspace" },
  },
});

const listSCIMConnectionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/scim/connections",
  tags: ["scim"],
  middleware: [requireHumanSession],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "SCIM connections for the workspace",
      content: {
        "application/json": {
          schema: z.object({
            connections: z.array(
              z.object({
                connectionId: z.string(),
                status: z.string(),
                createdAt: z.string(),
              })
            ),
          }),
        },
      },
    },
    403: { description: "Requires owner or admin role in the workspace" },
  },
});

async function requireWorkspaceAdmin(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  userId: string
) {
  const membership = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .get();
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "Requires owner or admin role in the workspace",
    });
  }
}

export function registerSCIMRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createSCIMConnectionRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const userId = c.get("userId");
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    await requireWorkspaceAdmin(db, organizationId, userId);

    const auth = await createAuth(c.env);
    const expiresAt = new Date(
      Date.now() + (input.expiresInDays ?? 90) * 86_400_000
    );
    const result = await auth.api.createSCIMManagedConnection({
      body: {
        creationRequestId: crypto.randomUUID(),
        provisioningDomainId: organizationId,
        actorId: userId,
        scopes: input.scopes ?? [...SCIM_SCOPES],
        expiresAt,
      },
    });
    await emitWorkspaceAudit(
      c,
      organizationId,
      "scim.connection.created",
      "scim_connection",
      result.connection.connectionId,
      {
        provisioningDomainId: { from: null, to: organizationId },
      }
    );
    return c.json(
      {
        connectionId: result.connection.connectionId,
        provisioningDomainId: result.connection.provisioningDomainId,
        token: result.token,
        baseUrl: `${c.env.BETTER_AUTH_URL}/api/auth/scim/v2`,
      },
      201
    );
  });

  app.openapi(listSCIMConnectionsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const userId = c.get("userId");
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    await requireWorkspaceAdmin(db, organizationId, userId);

    const auth = await createAuth(c.env);
    const result = await auth.api.listSCIMManagedConnections({
      body: { provisioningDomainId: organizationId },
    });
    return c.json({
      connections: result.connections.map((conn) => ({
        connectionId: conn.connectionId,
        status: conn.status,
        createdAt: conn.createdAt.toISOString(),
      })),
    });
  });
}

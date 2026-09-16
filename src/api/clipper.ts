import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  getWorkspaceById,
  getWorkspaceMembership,
  listWorkspacesForUser,
} from "../global/workspaces.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import {
  requireHumanSession,
  type AppContext,
} from "../platform/middleware.js";

const CLIPPER_TOKEN_NAME = "Pile Clipper";

const clipperWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

const authorizeBodySchema = z.object({
  workspaceId: z.string().min(1),
});

const createdKeySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().nullable(),
});

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Authentication required",
    });
  }
  return userId;
}

export function registerClipperRoutes(app: OpenAPIHono<AppContext>) {
  app.get("/clipper/workspaces", requireHumanSession, async (c) => {
    const userId = requireUserId(c.var.userId);
    const db = createD1(c.env.D1);
    const workspaces = await listWorkspacesForUser(db, userId);
    return c.json({
      workspaces: workspaces.map((workspace) =>
        clipperWorkspaceSchema.parse({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        })
      ),
    });
  });

  app.post("/clipper/authorize", requireHumanSession, async (c) => {
    const userId = requireUserId(c.var.userId);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Invalid JSON",
      });
    }
    const parsed = authorizeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Invalid request",
        hint: parsed.error.message,
      });
    }

    const db = createD1(c.env.D1);
    const workspace = await getWorkspaceById(db, parsed.data.workspaceId);
    if (!workspace) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }

    const membership = await getWorkspaceMembership(db, workspace.id, userId);
    if (!membership) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "User is not a member of this workspace",
      });
    }

    const auth = createAuth(c.env);
    const result = await auth.api.createApiKey({
      body: {
        userId,
        name: CLIPPER_TOKEN_NAME,
        metadata: {
          organizationId: workspace.id,
          permissions: "write",
          actorType: "user",
        },
      },
    });
    const key = createdKeySchema.parse(result);

    return c.json(
      {
        token: key.key,
        workspace: clipperWorkspaceSchema.parse({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        }),
      },
      201
    );
  });
}

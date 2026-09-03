import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import { findWorkspaceToken } from "../global/tokens.js";
import { getWorkspaceMembership } from "../global/workspaces.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import {
  toUserWorkspaceIdentity,
  toWorkspaceIdentity,
  type WorkspaceIdentity,
} from "../platform/identity.js";
import { getSessionUserId } from "../platform/session.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";

export interface WorkerEnv extends AppEnv {
  WORKSPACE_DURABLE_OBJECT: DurableObjectNamespace<WorkspaceDO>;
}

export type AppContext = {
  Bindings: WorkerEnv;
  Variables: { workspaceIdentity: WorkspaceIdentity; userId?: string };
};

export const workspaceAuthMiddleware = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: AppContext["Variables"];
}>(async (c, next) => {
  const workspaceId = c.req.param("workspaceId");
  const db = createD1(c.env.D1);
  const header = c.req.header("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (token) {
    const found = await findWorkspaceToken(db, token, c.env.TOKEN_HASH_SECRET);
    if (found) {
      if (workspaceId && found.workspaceId !== workspaceId) {
        throw new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: "Token does not belong to this workspace",
        });
      }
      c.set("workspaceIdentity", toWorkspaceIdentity(found));
      await next();
      return;
    }
  }

  const userId = await getSessionUserId(c.env, c.req.raw);
  if (!userId) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Authentication required",
    });
  }

  if (!workspaceId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Workspace not specified",
    });
  }

  const membership = await getWorkspaceMembership(db, workspaceId, userId);
  if (!membership) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "User is not a member of this workspace",
    });
  }

  c.set(
    "workspaceIdentity",
    toUserWorkspaceIdentity(userId, workspaceId, membership.role)
  );
  await next();
});

export const requireHumanSession = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: AppContext["Variables"];
}>(async (c, next) => {
  const userId = await getSessionUserId(c.env, c.req.raw);
  if (!userId) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Authentication required",
    });
  }
  c.set("userId", userId);
  await next();
});

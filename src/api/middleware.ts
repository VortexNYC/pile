import { createMiddleware } from "hono/factory";
import { createD1 } from "../global/db.js";
import { findWorkspaceToken } from "../global/tokens.js";
import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import {
  toWorkspaceIdentity,
  type WorkspaceIdentity,
} from "../platform/identity.js";

export type { WorkspaceToken } from "../platform/identity.js";

export interface WorkerEnv extends AppEnv {
  WORKSPACE_DURABLE_OBJECT: DurableObjectNamespace<WorkspaceDO>;
}

export type AppContext = {
  Bindings: WorkerEnv;
  Variables: { workspaceIdentity: WorkspaceIdentity };
};

export const workspaceTokenMiddleware = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: { workspaceIdentity: WorkspaceIdentity };
}>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Missing Authorization header",
    });
  }

  const db = createD1(c.env.D1);
  const found = await findWorkspaceToken(db, token);

  if (!found) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid or revoked token",
    });
  }

  const workspaceId = c.req.param("workspaceId");
  if (workspaceId && found.workspaceId !== workspaceId) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "Token does not belong to this workspace",
    });
  }

  c.set("workspaceIdentity", toWorkspaceIdentity(found));
  await next();
});

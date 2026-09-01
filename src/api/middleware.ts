import { createMiddleware } from "hono/factory";
import { createD1 } from "../global/db.js";
import { findWorkspaceToken } from "../global/tokens.js";
import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import { canAccess } from "../platform/permissions.js";
import type { workspaceTokens } from "../global/schema.js";
import type { InferSelectModel } from "drizzle-orm";

export type WorkspaceToken = InferSelectModel<typeof workspaceTokens>;

export type AppContext = {
  Bindings: AppEnv;
  Variables: { workspaceToken: WorkspaceToken };
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const workspaceTokenMiddleware = createMiddleware<{
  Bindings: AppEnv;
  Variables: { workspaceToken: WorkspaceToken };
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

  const action = READ_METHODS.has(c.req.method) ? "read" : "write";
  if (!canAccess(found.permissions, action)) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: `Token lacks ${action} permission`,
    });
  }

  c.set("workspaceToken", found);
  await next();
});

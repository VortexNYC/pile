import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import { getWorkspaceMembership } from "../global/workspaces.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { createAuth } from "./auth.js";
import type { AppEnv } from "./env.js";
import { VortexError } from "./errors.js";
import {
  toApiKeyWorkspaceIdentity,
  toUserWorkspaceIdentity,
  type WorkspaceIdentity,
} from "./identity.js";
import { getSessionUserId } from "./session.js";

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
  const organizationId = c.req.param("organizationId");
  const db = createD1(c.env.D1);
  const header = c.req.header("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (token) {
    const auth = createAuth(c.env);
    let result: unknown;
    try {
      result = await auth.api.verifyApiKey({
        body: { key: token },
      });
    } catch {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid or expired token",
      });
    }

    if (
      !result ||
      typeof result !== "object" ||
      !("valid" in result) ||
      !result.valid ||
      !("key" in result) ||
      !result.key
    ) {
      const code =
        "error" in result &&
        result.error &&
        typeof result.error === "object" &&
        "code" in result.error
          ? (result.error as { code?: string }).code
          : undefined;
      if (code === "RATE_LIMITED" || code === "RATE_LIMIT_EXCEEDED") {
        throw new VortexError({
          code: "RATE_LIMITED",
          status: 429,
          message: "API key rate limit exceeded",
        });
      }
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid or expired token",
      });
    }

    const identity = toApiKeyWorkspaceIdentity(result.key);
    if (organizationId && identity.organizationId !== organizationId) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Token does not belong to this workspace",
      });
    }
    c.set("workspaceIdentity", identity);
    await next();
    return;
  }

  const userId = await getSessionUserId(c.env, c.req.raw);
  if (!userId) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Authentication required",
    });
  }

  if (!organizationId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Workspace not specified",
    });
  }

  const membership = await getWorkspaceMembership(db, organizationId, userId);
  if (!membership) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "User is not a member of this workspace",
    });
  }

  c.set(
    "workspaceIdentity",
    toUserWorkspaceIdentity(userId, organizationId, membership.role)
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

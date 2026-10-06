import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import {
  getWorkspaceMembership,
  hasSSOAccountForWorkspace,
  isSSOEnforced,
} from "../global/workspaces.js";
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

// Browser WebSocket clients cannot set the Authorization header, so the
// realtime endpoints also accept the workspace API key as ?token=. Query
// credentials are scoped to these paths only — they must not become a
// general auth mechanism, since URLs end up in logs and browser history.
const QUERY_TOKEN_PATHS = /\/(realtime|ws)$/;

export const workspaceAuthMiddleware = createMiddleware<{
  Bindings: WorkerEnv;
  Variables: AppContext["Variables"];
}>(async (c, next) => {
  const organizationId = c.req.param("organizationId");
  const db = createD1(c.env.D1);
  const header = c.req.header("Authorization") ?? "";
  let token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token && QUERY_TOKEN_PATHS.test(c.req.path)) {
    token = c.req.query("token")?.trim() ?? "";
  }

  if (token) {
    const auth = await createAuth(c.env);
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
      const errObj =
        result && typeof result === "object" && "error" in result
          ? (result as { error?: unknown }).error
          : undefined;
      const code =
        errObj && typeof errObj === "object" && "code" in errObj
          ? (errObj as { code?: string }).code
          : undefined;
      if (code === "RATE_LIMITED" || code === "RATE_LIMIT_EXCEEDED") {
        throw new VortexError({
          code: "TOO_MANY_REQUESTS",
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
    // A key stays live only while its backing user still belongs to the
    // workspace — otherwise self-minted member keys would outlive the
    // membership that authorized them.
    if (
      !(await getWorkspaceMembership(db, identity.organizationId, identity.id))
    ) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Token owner is no longer a member of this workspace",
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

  // PATCH /workspaces/{id} is the ssoEnforced toggle — exempt it so a
  // workspace owner can always recover access if the IdP is misconfigured.
  const isSSOToggleRoute =
    c.req.method === "PATCH" && c.req.path === `/workspaces/${organizationId}`;
  if (
    !isSSOToggleRoute &&
    (await isSSOEnforced(db, organizationId)) &&
    !(await hasSSOAccountForWorkspace(db, organizationId, userId))
  ) {
    throw new VortexError({
      code: "SSO_REQUIRED",
      status: 403,
      message: "Workspace requires SSO sign-in",
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

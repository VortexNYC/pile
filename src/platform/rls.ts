import { createMiddleware } from "hono/factory";

import { VortexError } from "./errors.js";
import type { AppContext } from "./middleware.js";
import { canAccess } from "./permissions.js";

export function rls(...allowed: string[]) {
  return createMiddleware<AppContext>(async (c, next) => {
    const { permissions } = c.var.workspaceIdentity;
    const has = allowed.some((p) => canAccess(permissions, p));
    if (!has) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: `Required permission: ${allowed.join(" or ")}`,
      });
    }
    await next();
  });
}

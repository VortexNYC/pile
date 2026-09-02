import { createMiddleware } from "hono/factory";

import type { AppContext } from "../api/middleware.js";
import { VortexError } from "./errors.js";

export function rls(...allowed: string[]) {
  return createMiddleware<AppContext>(async (c, next) => {
    const identity = c.var.workspaceIdentity;
    const has = ["admin", ...allowed].some((p) =>
      identity.permissions.includes(p)
    );
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

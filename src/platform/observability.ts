import { createMiddleware } from "hono/factory";

import type { AppContext } from "./middleware.js";

export const observabilityMiddleware = createMiddleware<AppContext>(
  async (c, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    try {
      await next();
    } finally {
      const status = c.res?.status ?? 500;
      const duration = Date.now() - start;
      const log = {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs: duration,
      };
      console.log(JSON.stringify(log));
    }
  }
);

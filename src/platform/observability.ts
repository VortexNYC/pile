import { createMiddleware } from "hono/factory";

import type { AppContext } from "./middleware.js";

export const observabilityMiddleware = createMiddleware<AppContext>(
  async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header("X-Request-Id", requestId);
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
      if (status >= 500) {
        console.error(JSON.stringify(log));
      } else {
        console.log(JSON.stringify(log));
      }
    }
  }
);

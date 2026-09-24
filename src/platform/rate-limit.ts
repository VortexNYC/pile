import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import { VortexError } from "./errors.js";
import type { WorkerEnv } from "./middleware.js";

/**
 * Fixed-window rate limiter for anonymous public routes (capture ingest,
 * widget sessions/messages). Backed by the shared `rate_limit` D1 table —
 * the same store better-auth uses — keyed `pub:{ip}:{bucket}`.
 *
 * The upsert is a single statement so concurrent requests can't overshoot
 * the window boundary.
 */
export function publicRateLimit(options: {
  bucket: string;
  max: number;
  windowMs?: number;
}) {
  const windowMs = options.windowMs ?? 60_000;
  return createMiddleware<{ Bindings: WorkerEnv }>(async (c, next) => {
    // Cloudflare always sets cf-connecting-ip at the edge; when absent
    // (tests, non-CF contexts) there is no trustworthy client key, so skip.
    const ip = c.req.header("cf-connecting-ip");
    if (!ip) {
      await next();
      return;
    }
    const key = `pub:${ip}:${options.bucket}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    const db = createD1(c.env.D1);
    const rows = await db.all<{ count: number }>(
      sql`INSERT INTO rate_limit (id, key, count, last_request)
          VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
          ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN last_request < ${cutoff} THEN 1 ELSE count + 1 END,
            last_request = ${now}
          RETURNING count`
    );
    const count = rows[0]?.count ?? 1;
    c.header("X-RateLimit-Limit", String(options.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, options.max - count)));
    if (count > options.max) {
      throw new VortexError({
        code: "RATE_LIMITED",
        status: 429,
        message: "Too many requests",
      });
    }
    await next();
  });
}

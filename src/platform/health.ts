import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { createD1 } from "../global/db.js";
import type { AppContext } from "../api/middleware.js";

const healthBodySchema = z.object({
  ok: z.boolean(),
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  version: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      healthy: z.boolean(),
      message: z.string().optional(),
    })
  ),
});

export function registerHealthRoutes(
  app: OpenAPIHono<AppContext>
) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: ["platform"],
      responses: {
        200: {
          description: "Healthy or degraded",
          content: {
            "application/json": {
              schema: healthBodySchema,
            },
          },
        },
        503: {
          description: "Unhealthy",
          content: {
            "application/json": {
              schema: healthBodySchema,
            },
          },
        },
      },
    }),
    async (c) => {
      const checks: { name: string; healthy: boolean; message?: string }[] = [];
      const env = c.env;
      const version = "0.1.0";

      try {
        const db = createD1(env.D1);
        await db.run(sql`SELECT 1`);
        checks.push({ name: "d1", healthy: true });
      } catch (e) {
        checks.push({
          name: "d1",
          healthy: false,
          message: e instanceof Error ? e.message : "D1 probe failed",
        });
      }

      try {
        const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName("__health__");
        const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
        await stub.listIssues({ limit: 1 });
        checks.push({ name: "workspace-do", healthy: true });
      } catch (e) {
        checks.push({
          name: "workspace-do",
          healthy: false,
          message: e instanceof Error ? e.message : "DO probe failed",
        });
      }

      const healthy = checks.every((check) => check.healthy);
      const status: "healthy" | "unhealthy" = healthy
        ? "healthy"
        : "unhealthy";
      const statusCode = healthy ? 200 : 503;

      return c.json(
        {
          ok: healthy,
          status,
          version,
          checks,
        },
        statusCode
      );
    }
  );
}

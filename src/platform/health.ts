import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import type { AppContext } from "./middleware.js";

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

export function registerHealthRoutes(app: OpenAPIHono<AppContext>) {
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

      // Configuration presence checks — binding exists, no secrets exposed.
      // Missing config degrades rather than fails: self-hosters may not use
      // email or agents at all.
      const emailConfigured = Boolean(env.EMAIL && env.EMAIL_FROM);
      checks.push({
        name: "email",
        healthy: emailConfigured,
        message: emailConfigured ? undefined : "no EMAIL binding or EMAIL_FROM",
      });

      const computeProvider = env.COMPUTE_PROVIDER ?? "daytona";
      const sandboxConfigured =
        computeProvider === "daytona"
          ? Boolean(env.DAYTONA_API_KEY)
          : Boolean(env.SANDBOX);
      checks.push({
        name: "compute",
        healthy: sandboxConfigured,
        message: `provider=${computeProvider}`,
      });

      const healthy = checks.every((check) => check.healthy);
      const status: "healthy" | "degraded" | "unhealthy" = healthy
        ? "healthy"
        : checks.some((check) => check.healthy)
          ? "degraded"
          : "unhealthy";
      const statusCode = status === "unhealthy" ? 503 : 200;

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

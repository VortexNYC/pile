import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { exportWorkspaceData } from "../global/export.js";
import {
  githubInstallations,
  member,
  states,
  team,
  webhookSubscriptions,
} from "../global/schema.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const exportSchema = z
  .object({
    organizationId: z.string(),
    exportedAt: z.string(),
  })
  .passthrough();

const exportWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/export",
  tags: ["hardening"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace export",
      content: {
        "application/json": { schema: exportSchema },
      },
    },
  },
});

const readinessSchema = z.object({
  ready: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      required: z.boolean(),
    })
  ),
});

const readinessRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/readiness",
  tags: ["hardening"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace readiness",
      content: {
        "application/json": { schema: readinessSchema },
      },
    },
  },
});

export function registerHardeningRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(exportWorkspaceRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
    const issues = await stub.listIssues({ limit: 10000 });
    const history = await stub.listWorkspaceIssueHistory();
    const comments = await stub.listWorkspaceComments();

    const data = await exportWorkspaceData(db, organizationId);
    return c.json({ ...data, issues, history, comments });
  });

  app.openapi(readinessRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);

    const [
      issues,
      workspaceStates,
      workspaceTeams,
      workspaceMembers,
      workspaceGithubInstallations,
      workspaceWebhookSubscriptions,
    ] = await Promise.all([
      stub.listIssues({ limit: 1 }),
      db.select().from(states).where(eq(states.organizationId, organizationId)),
      db.select().from(team).where(eq(team.organizationId, organizationId)),
      db.select().from(member).where(eq(member.organizationId, organizationId)),
      db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.organizationId, organizationId)),
      db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.organizationId, organizationId)),
    ]);

    const checks = [
      { name: "states", ok: workspaceStates.length > 0, required: true },
      { name: "teams", ok: workspaceTeams.length > 0, required: true },
      { name: "members", ok: workspaceMembers.length > 0, required: true },
      { name: "issues", ok: issues.length > 0, required: false },
      {
        name: "github",
        ok: workspaceGithubInstallations.length > 0,
        required: false,
      },
      {
        name: "webhooks",
        ok: workspaceWebhookSubscriptions.length > 0,
        required: false,
      },
    ];

    const required = checks.filter((check) => check.required);
    const ready = required.every((check) => check.ok);

    return c.json({ ready, checks });
  });
}

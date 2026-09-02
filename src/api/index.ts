import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { toErrorResponse, VortexError } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import {
  workspaceTokenMiddleware,
  type AppContext,
} from "./middleware.js";
import { registerIssueRoutes } from "./issues.js";
import { registerWorkspaceEntityRoutes } from "./workspace-entities.js";
import { registerCommentRoutes } from "./comments.js";
import { registerIssueRelationRoutes } from "./issue-relations.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerIssueHistoryRoutes } from "./issue-history.js";
import { registerMigrateRoutes } from "./migrate.js";
import { createAuth } from "../platform/auth.js";
import { githubWebhookRoute, processGithubWebhook } from "../agents/github.js";
import { observabilityMiddleware } from "../platform/observability.js";
import { securityMiddleware } from "../platform/security.js";
import { registerHealthRoutes } from "../platform/health.js";

const app = new OpenAPIHono<AppContext>({
  defaultHook: (result) => {
    if (!result.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Invalid request",
        hint: result.error.message,
      });
    }
  },
});

app.onError((err) => {
  return toErrorResponse(err);
});

app.use("*", observabilityMiddleware);
app.use("*", ...securityMiddleware);

app.use("/workspaces/:workspaceId/*", workspaceTokenMiddleware);
registerIssueRoutes(app);
registerWorkspaceEntityRoutes(app);
registerCommentRoutes(app);
registerIssueRelationRoutes(app);
registerAttachmentRoutes(app);
registerIssueHistoryRoutes(app);
registerMigrateRoutes(app);
registerHealthRoutes(app);

app.openapi(
  createRoute({
    method: "get",
    path: "/workspaces/{workspaceId}/ws",
    tags: ["realtime"],
    request: {
      params: z.object({ workspaceId: z.string() }),
    },
    responses: {
      101: {
        description: "WebSocket upgraded",
      },
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid("param");
    const id = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(id);
    return await stub.fetch(c.req.raw);
  }
);

app.openapi(githubWebhookRoute, async (c) => c.json(await processGithubWebhook(c)));

app.all("/api/auth/*", (c) => {
  return createAuth(c.env).handler(c.req.raw);
});

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Vortex Issue Tracker",
    version: "0.1.0",
    description: "Agent-native issue tracker on Cloudflare Workers.",
  },
});

export default app;

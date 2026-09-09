import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { githubWebhookRoute, processGithubWebhook } from "../agents/github.js";
import { handleMcpRequest } from "../mcp/server.js";
import { createAuth } from "../platform/auth.js";
import { toErrorResponse, VortexError } from "../platform/errors.js";
import { registerHealthRoutes } from "../platform/health.js";
import {
  type AppContext,
  workspaceAuthMiddleware,
} from "../platform/middleware.js";
import { observabilityMiddleware } from "../platform/observability.js";
import { securityMiddleware } from "../platform/security.js";
import { registerActivityRoutes } from "./activities.js";
import { registerAgentProviderRoutes } from "./agent-providers.js";
import { registerAgentRoutes } from "./agents.js";
import { registerAgentSessionRoutes } from "./agent-sessions.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerAuditRoutes } from "./audit.js";
import { registerCustomerRoutes } from "./customers.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerCommentRoutes } from "./comments.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerDocsSiteRoutes } from "./docs-site.js";
import { registerGithubRoutes } from "./github.js";
import { registerHardeningRoutes } from "./hardening.js";
import { registerIssueHistoryRoutes } from "./issue-history.js";
import { registerIssueRelationRoutes } from "./issue-relations.js";
import { registerIssueSubscriberRoutes } from "./issue-subscribers.js";
import { registerIssueRoutes } from "./issues.js";
import { registerLinearUserRoutes } from "./linear-users.js";
import { registerMigrateRoutes } from "./migrate.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerReactionRoutes } from "./reactions.js";
import { registerSavedViewRoutes } from "./saved-views.js";
import {
  handleSlackEvents,
  handleSlackOAuth,
  registerSlackRoutes,
} from "./slack.js";
import { registerStateRoutes } from "./states.js";
import { registerTeamRoutes } from "./teams.js";
import { registerTemplateRoutes } from "./templates.js";
import { registerTokenRoutes } from "./tokens.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerWorkspaceEntityRoutes } from "./workspace-entities.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

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

app.use("/workspaces/:organizationId/*", workspaceAuthMiddleware);
registerWorkspaceRoutes(app);
registerTokenRoutes(app);
registerIssueRoutes(app);
registerAgentSessionRoutes(app);
registerAgentProviderRoutes(app);
registerAgentRoutes(app);
registerApprovalRoutes(app);
registerActivityRoutes(app);
registerWorkspaceEntityRoutes(app);
registerCommentRoutes(app);
registerDocumentRoutes(app);
registerDocsSiteRoutes(app);
registerAuditRoutes(app);
registerCustomerRoutes(app);
registerReleaseRoutes(app);
registerIssueRelationRoutes(app);
registerIssueSubscriberRoutes(app);
registerAttachmentRoutes(app);
registerGithubRoutes(app);
registerIssueHistoryRoutes(app);
registerStateRoutes(app);
registerWebhookRoutes(app);
registerLinearUserRoutes(app);
registerNotificationRoutes(app);
registerReactionRoutes(app);
registerSavedViewRoutes(app);
registerTeamRoutes(app);
registerTemplateRoutes(app);
registerMigrateRoutes(app);
registerHardeningRoutes(app);
registerSlackRoutes(app);
registerHealthRoutes(app);

app.openapi(githubWebhookRoute, processGithubWebhook);

app.get("/slack/oauth", async (c) => await handleSlackOAuth(c));
app.post(
  "/slack/events",
  async (c) =>
    await handleSlackEvents({
      env: c.env,
      req: c.req,
      waitUntil: (task) => c.executionCtx.waitUntil(task),
    })
);

app.openapi(
  createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/ws",
    tags: ["realtime"],
    request: {
      params: z.object({ organizationId: z.string() }),
    },
    responses: {
      101: {
        description: "WebSocket upgraded",
      },
    },
  }),
  async (c) => {
    const { organizationId } = c.req.valid("param");
    const id = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(id);
    return await stub.fetch(c.req.raw);
  }
);

app.openapi(githubWebhookRoute, async (c) =>
  c.json(await processGithubWebhook(c))
);

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

app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw, c.env, app);
});

export default app;

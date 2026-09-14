import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { githubWebhookRoute, processGithubWebhook } from "../agents/github.js";
import { gitlabWebhookRoute, processGitlabWebhook } from "../agents/gitlab.js";
import {
  intercomWebhookRoute,
  processIntercomWebhook,
} from "../agents/intercom.js";
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
import { registerAgentSessionRoutes } from "./agent-sessions.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerAuditRoutes } from "./audit.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBillingRoutes } from "./billing.js";
import { registerCommentRoutes } from "./comments.js";
import { registerCsvExportRoutes } from "./csv-export.js";
import { registerCustomerRoutes } from "./customers.js";
import { registerDocsSiteRoutes } from "./docs-site.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerEmailInboxRoutes } from "./email-inboxes.js";
import { registerEmojiRoutes } from "./emojis.js";
import { registerExternalLinkRoutes } from "./external-links.js";
import { registerFileRoutes } from "./files.js";
import { registerGitAutomationRoutes } from "./git-automation.js";
import { registerGithubRoutes } from "./github.js";
import { registerGitlabRoutes } from "./gitlab.js";
import { registerHardeningRoutes } from "./hardening.js";
import { registerImportRoutes } from "./import.js";
import { registerIssueExternalLinkRoutes } from "./issue-external-links.js";
import { registerIssueHistoryRoutes } from "./issue-history.js";
import { registerIssueRelationRoutes } from "./issue-relations.js";
import { registerIssueSubscriberRoutes } from "./issue-subscribers.js";
import { registerIssueRoutes } from "./issues.js";
import { registerLinearUserRoutes } from "./linear-users.js";
import { registerMcpServerRoutes } from "./mcp-servers.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerNotionWebhookRoute } from "./notion-webhook.js";
import { registerNotionRoutes } from "./notion.js";
import { registerOAuthClientRoutes } from "./oauth-clients.js";
import { registerObservabilityRoutes } from "./observability.js";
import { registerProjectMemberRoutes } from "./project-members.js";
import { registerProjectDetailRoutes } from "./projects.js";
import { registerPushRoutes } from "./push.js";
import { registerReactionRoutes } from "./reactions.js";
import { registerRealtimeRoutes } from "./realtime.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerSavedViewRoutes } from "./saved-views.js";
import { registerSearchRoutes } from "./search.js";
import { registerSkillRoutes } from "./skills.js";
import {
  handleSlackEvents,
  handleSlackOAuth,
  registerSlackRoutes,
} from "./slack.js";
import { registerStateRoutes } from "./states.js";
import { registerSupportCaptureRoutes } from "./support-capture.js";
import { registerSupportChannelRoutes } from "./support-channels.js";
import { registerSupportContactRoutes } from "./support-contacts.js";
import { registerSupportContentRoutes } from "./support-content.js";
import { registerSupportEscalationRoutes } from "./support-escalation.js";
import { registerSupportInboxRoutes } from "./support-inbox.js";
import { registerSupportMigrationRoutes } from "./support-migration.js";
import { registerSupportTeamRoutes } from "./support-team.js";
import { registerSupportTicketRoutes } from "./support-tickets.js";
import { registerTeamRoutes } from "./teams.js";
import { registerTemplateRoutes } from "./templates.js";
import { registerTimeScheduleRoutes } from "./time-schedules.js";
import { registerTokenRoutes } from "./tokens.js";
import { registerUsageRoutes } from "./usage.js";
import { registerViewPreferenceRoutes } from "./view-preferences.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerWorkspaceEntityRoutes } from "./workspace-entities.js";
import { registerWorkspaceUserRoutes } from "./workspace-users.js";
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

app.use("/workspaces/:organizationId/*", async (c, next) => {
  if (c.req.path === "/workspaces/onboard") {
    await next();
    return;
  }
  await workspaceAuthMiddleware(c, next);
});
registerWorkspaceRoutes(app);
registerTokenRoutes(app);
registerOAuthClientRoutes(app);
registerIssueRoutes(app);
registerAgentSessionRoutes(app);
registerAgentProviderRoutes(app);
registerApprovalRoutes(app);
registerActivityRoutes(app);
registerWorkspaceEntityRoutes(app);
registerExternalLinkRoutes(app);
registerProjectDetailRoutes(app);
registerProjectMemberRoutes(app);
registerEmailInboxRoutes(app);
registerSupportCaptureRoutes(app);
registerSupportChannelRoutes(app);
registerWorkspaceUserRoutes(app);
registerUsageRoutes(app);
registerBillingRoutes(app);
registerViewPreferenceRoutes(app);
registerTimeScheduleRoutes(app);
registerGitAutomationRoutes(app);
registerFileRoutes(app);
registerGitlabRoutes(app);
registerCommentRoutes(app);
registerDocumentRoutes(app);
registerEmojiRoutes(app);
registerDocsSiteRoutes(app);
registerAuditRoutes(app);
registerCustomerRoutes(app);
registerSupportContactRoutes(app);
registerSupportTicketRoutes(app);
registerSupportContentRoutes(app);
registerSupportEscalationRoutes(app);
registerSupportInboxRoutes(app);
registerSupportMigrationRoutes(app);
registerSupportTeamRoutes(app);
registerCsvExportRoutes(app);
registerReleaseRoutes(app);
registerIssueRelationRoutes(app);
registerIssueExternalLinkRoutes(app);
registerMcpServerRoutes(app);
registerSkillRoutes(app);
registerIssueSubscriberRoutes(app);
registerAttachmentRoutes(app);
registerGithubRoutes(app);
registerIssueHistoryRoutes(app);
registerStateRoutes(app);
registerWebhookRoutes(app);
registerLinearUserRoutes(app);
registerNotificationRoutes(app);
registerObservabilityRoutes(app);
registerPushRoutes(app);
registerReactionRoutes(app);
registerRealtimeRoutes(app);
registerSavedViewRoutes(app);
registerSearchRoutes(app);
registerTeamRoutes(app);
registerTemplateRoutes(app);
registerImportRoutes(app);
registerNotionRoutes(app);
registerNotionWebhookRoute(app);
registerHardeningRoutes(app);
registerSlackRoutes(app);
registerHealthRoutes(app);
registerAuthRoutes(app);

app.openapi(githubWebhookRoute, processGithubWebhook);
app.openapi(gitlabWebhookRoute, processGitlabWebhook);

app.openapi(intercomWebhookRoute, async (c) =>
  c.json(await processIntercomWebhook(c))
);

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

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

app.get("/api/auth/organization/accept-invitation", (c) => {
  const { id, invitationId } = z
    .object({
      id: z.string().optional(),
      invitationId: z.string().optional(),
    })
    .parse(c.req.query());
  const inviteId = id ?? invitationId;
  if (!inviteId) {
    return c.text("Missing invitation id", 400);
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accept Invitation</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 1rem; text-align: center; }
    button { padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; }
    #status { margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Accept Invitation</h1>
  <p>Click below to accept the invitation and join the workspace.</p>
  <input id="invitationId" type="hidden" value="${htmlEscape(inviteId)}" />
  <button id="accept">Accept Invitation</button>
  <p id="status"></p>
  <script>
    document.getElementById("accept").addEventListener("click", async () => {
      const inviteId = document.getElementById("invitationId").value;
      const res = await fetch("/api/auth/organization/accept-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: inviteId }),
      });
      const text = await res.text();
      document.getElementById("status").textContent = res.ok
        ? "Invitation accepted. You can close this window."
        : "Error: " + text;
    });
  </script>
</body>
</html>`;
  return c.html(html);
});

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

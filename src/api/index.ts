import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { verifySessionToken } from "../agents/credentials.js";
import { githubWebhookRoute, processGithubWebhook } from "../agents/github.js";
import { gitlabWebhookRoute, processGitlabWebhook } from "../agents/gitlab.js";
import {
  intercomWebhookRoute,
  processIntercomWebhook,
} from "../agents/intercom.js";
import { docsBundle } from "../assets/docs-bundle.js";
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
import { registerAgentContextRoutes } from "./agent-context.js";
import { registerAgentEnvironmentRoutes } from "./agent-environment.js";
import { registerAgentProviderRoutes } from "./agent-providers.js";
import { registerAgentSessionRoutes } from "./agent-sessions.js";
import { registerAppRoute } from "./app.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerAuditRoutes } from "./audit.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBillingWebhookRoutes } from "./billing-webhook.js";
import { registerBillingRoutes } from "./billing.js";
import { registerChangelogRoutes } from "./changelog.js";
import { registerClipperRoutes } from "./clipper.js";
import { registerCommentRoutes } from "./comments.js";
import { registerCsvExportRoutes } from "./csv-export.js";
import { registerCustomerRoutes } from "./customers.js";
import { registerDocsSiteRoutes } from "./docs-site.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerEmailInboxRoutes } from "./email-inboxes.js";
import { registerEmojiRoutes } from "./emojis.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { registerExternalLinkRoutes } from "./external-links.js";
import { registerFileRoutes } from "./files.js";
import { registerGitAutomationRoutes } from "./git-automation.js";
import { registerGitIdentityRoutes } from "./git-identities.js";
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
import { registerPrRoutes } from "./pr.js";
import { registerProjectMemberRoutes } from "./project-members.js";
import { registerProjectDetailRoutes } from "./projects.js";
import { registerPushRoutes } from "./push.js";
import { registerReactionRoutes } from "./reactions.js";
import { registerRealtimeRoutes } from "./realtime.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerSavedViewRoutes } from "./saved-views.js";
import { registerSCIMRoutes } from "./scim.js";
import { registerSearchRoutes } from "./search.js";
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
import { registerSupportTraceRoutes } from "./support-trace.js";
import { registerSupportWidgetRoutes } from "./support-widget.js";
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
  // Slug lookup carries its own workspaceReadAccess gate — "slug" is not a
  // real organizationId, so the generic middleware would 403 everything.
  if (c.req.path.startsWith("/workspaces/slug/")) {
    await next();
    return;
  }
  // Public roadmap board — anonymous read of public-flagged tickets only.
  if (c.req.path.endsWith("/board") && c.req.method === "GET") {
    await next();
    return;
  }
  // Changelog RSS — anonymous feed readers carry no credentials.
  if (c.req.path.endsWith("/changelog.rss") && c.req.method === "GET") {
    await next();
    return;
  }
  // Changelog list — anonymous gets published only; a presented token goes
  // through normal auth so includeDrafts stays staff-only.
  if (
    c.req.path.endsWith("/changelog") &&
    c.req.method === "GET" &&
    !c.req.header("Authorization")
  ) {
    await next();
    return;
  }
  // Agent runners push log lines and fetch/upload the pnpm store cache with a
  // per-session HMAC token instead of a user/API-key identity — verified
  // inside the route handlers.
  if (
    /\/agent\/sessions\/[^/]+\/(logs|report|github-token|cache\/pnpm-store\/[a-f0-9]{64}(\/parts\/\d+|\/manifest)?)$/.test(
      c.req.path
    ) &&
    (c.req.method === "POST" ||
      c.req.method === "GET" ||
      c.req.method === "PUT")
  ) {
    await next();
    return;
  }
  // Lane-token reads (PILE-232): a lane may read back only its own session
  // record and event timeline. Unlike the write routes above, these paths
  // are shared with workspace-authenticated callers, so the bypass only
  // applies when the bearer actually validates as the lane token for that
  // session — everyone else falls through to workspace auth as usual.
  const laneGet =
    c.req.method === "GET" &&
    /^\/workspaces\/([^/]+)\/agent\/sessions\/([^/]+)(\/(events|checks))?$/.exec(
      c.req.path
    );
  if (
    laneGet &&
    (await verifySessionToken(
      c.env,
      c.req.header("authorization"),
      laneGet[1]!,
      laneGet[2]!
    ))
  ) {
    // A valid lane token becomes a scoped agent identity — enough for
    // agent:read routes, nothing else.
    c.set("workspaceIdentity", {
      id: `lane:${laneGet[2]}`,
      organizationId: laneGet[1]!,
      type: "agent",
      permissions: ["agent:read"],
    });
    await next();
    return;
  }
  await workspaceAuthMiddleware(c, next);
});
registerWorkspaceRoutes(app);
registerSCIMRoutes(app);
registerTokenRoutes(app);
registerClipperRoutes(app);
registerOAuthClientRoutes(app);
registerIssueRoutes(app);
registerAgentSessionRoutes(app);
registerAgentProviderRoutes(app);
registerAgentEnvironmentRoutes(app);
registerApprovalRoutes(app);
registerActivityRoutes(app);
registerWorkspaceEntityRoutes(app);
registerExternalLinkRoutes(app);
registerProjectDetailRoutes(app);
registerPrRoutes(app);
registerProjectMemberRoutes(app);
registerEmailInboxRoutes(app);
registerAgentContextRoutes(app);
registerSupportCaptureRoutes(app);
registerSupportWidgetRoutes(app);
registerSupportChannelRoutes(app);
registerWorkspaceUserRoutes(app);
registerUsageRoutes(app);
registerBillingRoutes(app);
registerBillingWebhookRoutes(app);
registerViewPreferenceRoutes(app);
registerTimeScheduleRoutes(app);
registerGitAutomationRoutes(app);
registerGitIdentityRoutes(app);
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
registerChangelogRoutes(app);
registerSupportTraceRoutes(app);
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
      waitUntil: (task) => getExecutionCtx(c)?.waitUntil(task),
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

registerAppRoute(app);

app.all("/api/auth/*", async (c) => {
  return (await createAuth(c.env)).handler(c.req.raw);
});

app.get("/", (c) => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pile — agent-native issue tracker + support</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, monospace; max-width: 640px; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } code { background: #f0f0f0; padding: 0.1em 0.35em; }
  pre { background: #f6f6f6; padding: 1rem; overflow-x: auto; font-size: 0.85rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Pile</h1>
<p>Agent-native issue tracker and support desk. Your coding agent is a
first-class user: it can record a bug, read the capture artifacts
(replay, console, network, debugger state), and open the fix PR — the
support ticket and the engineering issue are the same object.</p>
<pre>npm i @vortex-api/pile
pile auth login
pile issues create --title "…"</pre>
<p>
<a href="/openapi.json">openapi.json</a> ·
<a href="/llms.txt">llms.txt</a> ·
<a href="/llms-full.txt">llms-full.txt</a> ·
<a href="/mcp">mcp</a>
</p>
</body>
</html>`;
  return c.html(html);
});

app.get("/llms.txt", (c) => {
  const body = `# Pile

> Agent-native issue tracker + support desk on Cloudflare. The support ticket
> and the engineering issue are the same object; coding agents are first-class
> users that can record bugs, read capture artifacts, and open fix PRs.

## Surfaces

- API (OpenAPI): /openapi.json — every surface is API-first
- MCP: /mcp — issue/ticket/workspace tools for agents
- CLI + SDK + capture + widget: npm i @vortex-api/pile
  - ./capture — browser capture SDK (initCapture)
  - ./chat.js — embeddable support widget bundle
  - ./capture.iife.js — one-tag capture script

## Docs

${Object.keys(docsBundle)
  .map((f) => `- [${f.replace(/\.md$/, "")}](/docs/${f})`)
  .join("\n")}

## Quickstart

1. Sign up: POST /api/auth/sign-up/email {email, password, name}
2. Onboard: POST /workspaces/onboard {name, slug, key} → returns admin API key
3. Use: Authorization: Bearer <key> on /workspaces/{org}/...
`;
  return c.text(body);
});

app.get("/llms-full.txt", (c) => {
  const body = Object.entries(docsBundle)
    .map(([name, md]) => `\n\n# ===== docs/${name} =====\n\n${md}`)
    .join("");
  return c.text(`# Pile — full documentation\n${body}`);
});

app.get("/.well-known/security.txt", (c) =>
  c.text(
    "Contact: mailto:security@vortexnyc.com\nPreferred-Languages: en\nCanonical: https://pile.nyc/.well-known/security.txt\n"
  )
);

app.get("/status", (c) => c.redirect("/health", 308));

app.get("/docs/:name", (c) => {
  const name = c.req.param("name");
  const doc = docsBundle[name];
  if (!doc || !name.endsWith(".md")) {
    return c.text("Not found", 404);
  }
  return c.text(doc, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Pile",
    version: "0.1.0",
    description: "Agent-native issue tracker on Cloudflare Workers.",
  },
});

app.all("/mcp", async (c) => {
  return handleMcpRequest(c.req.raw, c.env, app);
});

export default app;

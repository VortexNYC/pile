import { parseSlackWebhookBody } from "@chat-adapter/slack/webhook";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { slackInstallations } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { createSlackBot, isSlackConfigured } from "../slack/bot.js";
import { handleSlackUnfurl, isLinkSharedPayload } from "../slack/unfurl.js";

const slackStatusSchema = z.object({
  installed: z.boolean(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  defaultChannelId: z.string().nullable(),
});

const SLACK_OAUTH_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "commands",
  "groups:read",
  "im:read",
  "im:write",
];

const slackStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/slack",
  tags: ["slack"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Slack installation status",
      content: {
        "application/json": { schema: slackStatusSchema },
      },
    },
  },
});

const slackInstallRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/slack/install",
  tags: ["slack"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Slack OAuth install URL",
      content: {
        "application/json": {
          schema: z.object({ url: z.string() }),
        },
      },
    },
  },
});

const slackChannelRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/slack/channel",
  tags: ["slack"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ channelId: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Default channel updated",
      content: {
        "application/json": { schema: slackStatusSchema },
      },
    },
  },
});

const slackDeleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/slack",
  tags: ["slack"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    204: {
      description: "Slack installation removed",
    },
  },
});

async function getInstallationRow(c: {
  env: { D1: D1Database };
  req: { valid: (target: "param") => { organizationId: string } };
}) {
  const { organizationId } = c.req.valid("param");
  const db = createD1(c.env.D1);
  const row = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.organizationId, organizationId))
    .get();
  return { organizationId, db, row };
}

export function registerSlackRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(slackStatusRoute, async (c) => {
    const { row } = await getInstallationRow(c);
    return c.json({
      installed: Boolean(row),
      teamId: row?.teamId ?? null,
      teamName: row?.teamName ?? null,
      defaultChannelId: row?.defaultChannelId ?? null,
    });
  });

  app.openapi(slackInstallRoute, async (c) => {
    if (!isSlackConfigured(c.env) || !c.env.SLACK_REDIRECT_URI) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 503,
        message: "Slack is not configured on this deployment",
      });
    }
    const { organizationId } = c.req.valid("param");
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", c.env.SLACK_CLIENT_ID ?? "");
    url.searchParams.set("scope", SLACK_OAUTH_SCOPES.join(","));
    url.searchParams.set("redirect_uri", c.env.SLACK_REDIRECT_URI);
    url.searchParams.set("state", organizationId);
    return c.json({ url: url.toString() });
  });

  app.openapi(slackChannelRoute, async (c) => {
    const { channelId } = c.req.valid("json");
    const { db, row } = await getInstallationRow(c);
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Slack is not installed for this workspace",
      });
    }
    await db
      .update(slackInstallations)
      .set({ defaultChannelId: channelId })
      .where(eq(slackInstallations.id, row.id));
    return c.json({
      installed: true,
      teamId: row.teamId,
      teamName: row.teamName ?? null,
      defaultChannelId: channelId,
    });
  });

  app.openapi(slackDeleteRoute, async (c) => {
    const { db, row } = await getInstallationRow(c);
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Slack is not installed for this workspace",
      });
    }
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.id, row.id));
    if (isSlackConfigured(c.env)) {
      const { slack, bot } = createSlackBot(c.env);
      await bot.initialize();
      await slack.deleteInstallation(row.teamId);
    }
    return c.body(null, 204);
  });
}

/**
 * Slack OAuth V2 callback. Slack redirects here after install; `state` carries
 * the Vortex organizationId from the install URL.
 */
export async function handleSlackOAuth(c: {
  env: WorkerEnv;
  req: { raw: Request };
}): Promise<Response> {
  if (!isSlackConfigured(c.env)) {
    throw new VortexError({
      code: "AGENT_ERROR",
      status: 503,
      message: "Slack is not configured on this deployment",
    });
  }
  const url = new URL(c.req.raw.url);
  const organizationId = url.searchParams.get("state");
  if (!organizationId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing state parameter",
    });
  }

  const { slack, bot } = createSlackBot(c.env);
  await bot.initialize();
  const result = await slack.handleOAuthCallback(c.req.raw, {
    redirectUri: c.env.SLACK_REDIRECT_URI,
  });

  const db = createD1(c.env.D1);
  await db
    .insert(slackInstallations)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      teamId: result.teamId,
      teamName: result.installation.teamName ?? null,
      enterpriseId: result.enterpriseId ?? null,
      isEnterpriseInstall: result.isEnterpriseInstall,
    })
    .onConflictDoUpdate({
      target: slackInstallations.teamId,
      set: {
        organizationId,
        teamName: result.installation.teamName ?? null,
        enterpriseId: result.enterpriseId ?? null,
        isEnterpriseInstall: result.isEnterpriseInstall,
      },
    });

  return new Response(JSON.stringify({ ok: true, teamId: result.teamId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Slack Events API + interactivity endpoint. The body is read once to pull the
 * team_id for workspace resolution, then the request is rebuilt and handed to
 * the Chat SDK webhook handler for signature verification and dispatch.
 */
export async function handleSlackEvents(c: {
  env: WorkerEnv;
  req: { raw: Request };
  waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  if (!isSlackConfigured(c.env)) {
    return new Response("Slack not configured", { status: 503 });
  }

  const rawBody = await c.req.raw.text();

  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(rawBody);
  } catch {
    rawEvent = undefined;
  }
  if (isLinkSharedPayload(rawEvent)) {
    c.waitUntil(handleSlackUnfurl(c.env, rawEvent));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let teamId: string | undefined;
  try {
    const payload = parseSlackWebhookBody(rawBody);
    teamId =
      "teamId" in payload && typeof payload.teamId === "string"
        ? payload.teamId
        : undefined;
  } catch {
    teamId = undefined;
  }

  const request = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: rawBody,
  });

  const { bot } = createSlackBot(c.env, teamId);
  return await bot.webhooks.slack(request, { waitUntil: c.waitUntil });
}

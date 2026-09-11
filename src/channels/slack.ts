import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { hmacSha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { supportChannels } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";

const slackEventSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      channel: z.string(),
      user: z.string(),
      text: z.string().default(""),
      ts: z.string(),
      thread_ts: z.string().optional(),
      user_profile: z
        .object({
          email: z.string().email().optional(),
          name: z.string().optional(),
        })
        .optional(),
      bot_id: z.string().optional(),
      subtype: z.string().optional(),
    })
    .optional(),
});

export const slackSupportWebhookRoute = createRoute({
  method: "post",
  path: "/support/webhooks/slack/{organizationId}",
  tags: ["support-channels"],
  summary: "Receive Slack support events",
  middleware: [],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: z.unknown() } },
      required: true,
    },
    headers: z.object({
      "x-slack-signature": z.string().optional(),
      "x-slack-request-timestamp": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            challenge: z.string().optional(),
          }),
        },
      },
    },
  },
});

export async function processSlackSupportWebhook(
  c: Context<AppContext>
): Promise<{ ok: boolean; challenge?: string }> {
  const organizationId = c.req.param("organizationId");
  if (!organizationId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing organization ID",
    });
  }

  const secret = c.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Slack signing secret is not configured",
    });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Slack-Signature");
  const timestamp = c.req.header("X-Slack-Request-Timestamp");
  if (!signature || !timestamp) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Missing Slack signature headers",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || now - ts > 300) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Stale Slack request",
    });
  }

  const expected = signature.startsWith("v0=")
    ? signature.slice(3).toLowerCase()
    : signature.toLowerCase();
  const computed = await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`);
  if (!timingSafeEqualHex(expected, computed)) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid Slack signature",
    });
  }

  const parsed = JSON.parse(rawBody) as unknown;
  const body = slackEventSchema.parse(parsed);

  if (body.type === "url_verification") {
    return { ok: true, challenge: body.challenge };
  }

  if (body.type !== "event_callback" || !body.event) {
    return { ok: true };
  }

  const ev = body.event;
  if (ev.type !== "message" || ev.bot_id || ev.subtype) {
    return { ok: true };
  }

  const db = createD1(c.env.D1);
  const [channel] = await db
    .select()
    .from(supportChannels)
    .where(
      and(
        eq(supportChannels.organizationId, organizationId),
        eq(supportChannels.type, "slack"),
        eq(supportChannels.isActive, true),
        eq(supportChannels.name, ev.channel)
      )
    )
    .limit(1);

  if (!channel) {
    return { ok: true };
  }

  const email = ev.user_profile?.email;
  if (!email) {
    return { ok: true };
  }

  const createdAt = new Date(Number(ev.ts) * 1000).toISOString();
  await processIncomingMessage(
    db,
    organizationId,
    {
      channel: "slack",
      externalSource: "slack",
      fromEmail: email,
      fromName: ev.user_profile?.name ?? null,
      subject: "",
      text: ev.text,
      externalTicketId: ev.thread_ts ?? ev.ts,
      externalMessageId: ev.ts,
      createdAt,
    },
    c.env
  );

  return { ok: true };
}

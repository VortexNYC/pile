import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { hmacSha1Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import type { D1Client } from "../global/db.js";
import {
  createIntercomConversation,
  findIntercomConversation,
} from "../global/intercom-conversations.js";
import { enqueueWebhook, scopedDeliveryId } from "../global/webhook-queue.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import type { IssueInput } from "../types/workspace.js";

const intercomWebhookAuthorSchema = z.object({
  type: z.enum(["admin", "user", "lead", "bot", "contact"]),
  id: z.string(),
  name: z.string().nullable().default(null),
  email: z.string().email().nullable().default(null),
});

const intercomWebhookSourceSchema = z.object({
  type: z.string(),
  id: z.string(),
  delivered_as: z.string().optional(),
  subject: z.string().default(""),
  body: z.string().default(""),
  author: intercomWebhookAuthorSchema.nullable().default(null),
});

const intercomWebhookConversationSchema = z.object({
  type: z.literal("conversation"),
  id: z.string(),
  title: z.string().nullable().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  state: z.enum(["open", "closed", "snoozed"]).default("open"),
  priority: z
    .enum(["priority", "not_priority"])
    .optional()
    .default("not_priority"),
  open: z.boolean().default(true),
  read: z.boolean().default(false),
  source: intercomWebhookSourceSchema.nullable().default(null),
});

const intercomNotificationSchema = z.object({
  type: z.literal("notification_event"),
  id: z.string(),
  topic: z.string(),
  app_id: z.string(),
  created_at: z.number().int(),
  delivery_attempts: z.number().int().default(1),
  data: z.object({
    item: z.unknown(),
  }),
});

type IntercomWebhookConversation = z.infer<
  typeof intercomWebhookConversationSchema
>;

function intercomStateToVortexStatus(
  state: IntercomWebhookConversation["state"]
): IssueInput["status"] {
  const map: Record<string, IssueInput["status"]> = {
    open: "triage",
    closed: "done",
    snoozed: "backlog",
  };
  return map[state] ?? "triage";
}

function intercomPriorityToVortexPriority(
  priority: IntercomWebhookConversation["priority"]
): IssueInput["priority"] {
  return priority === "priority" ? "high" : "medium";
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function conversationTitle(conversation: IntercomWebhookConversation): string {
  if (conversation.title) return conversation.title;
  const subject = conversation.source?.subject;
  if (subject) return subject;
  const bodyPreview = stripHtml(conversation.source?.body).slice(0, 120);
  if (bodyPreview) return bodyPreview;
  return `Intercom conversation ${conversation.id}`;
}

function conversationBody(conversation: IntercomWebhookConversation): string {
  const body = conversation.source?.body ?? "";
  if (body) return body;
  const subject = conversation.source?.subject ?? "";
  if (subject) return `<p>${subject}</p>`;
  return "";
}

export const intercomWebhookRoute = createRoute({
  method: "post",
  path: "/intercom/{organizationId}",
  tags: ["webhooks"],
  summary: "Receive Intercom webhook notifications",
  middleware: [],
  request: {
    params: z.object({
      organizationId: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.unknown(),
        },
      },
      required: true,
    },
    headers: z.object({
      "x-hub-signature": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
});

const intercomAgentQueuePayloadSchema = z.object({
  notification: intercomNotificationSchema,
  organizationId: z.string(),
});

export async function processIntercomWebhook(
  c: Context<AppContext>
): Promise<{ ok: boolean }> {
  const secret = c.env.INTERCOM_CLIENT_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Intercom webhook secret is not configured",
    });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature");
  if (!signature || !signature.startsWith("sha1=")) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Missing or invalid Intercom signature",
    });
  }

  const expected = signature.slice(5).toLowerCase();
  const computed = await hmacSha1Hex(secret, rawBody);
  if (!timingSafeEqualHex(expected, computed)) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid Intercom signature",
    });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const notification = intercomNotificationSchema.safeParse(parsedBody);
  if (!notification.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Intercom notification",
      hint: notification.error.message,
    });
  }

  const organizationId = c.req.param("organizationId");
  if (!organizationId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing organizationId",
    });
  }
  const { id: deliveryId, topic } = notification.data;

  if (topic === "ping" || !topic.startsWith("conversation.")) {
    return { ok: true };
  }

  const db = createD1(c.env.D1);
  await enqueueWebhook(
    db,
    c.env,
    {
      deliveryId: scopedDeliveryId(
        "intercom-agent",
        organizationId,
        deliveryId
      ),
      source: "intercom-agent",
      event: topic,
      organizationId,
      payload: { notification: notification.data, organizationId },
    },
    new Map([["intercom-agent", processIntercomAgentWebhookPayload]])
  );

  return { ok: true };
}

export async function processIntercomAgentWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<void> {
  const parsed = intercomAgentQueuePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Intercom agent queue payload",
      hint: parsed.error.message,
    });
  }

  const { notification, organizationId } = parsed.data;
  const conversation = intercomWebhookConversationSchema.safeParse(
    notification.data.item
  );
  if (!conversation.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Intercom conversation payload",
      hint: conversation.error.message,
    });
  }

  const stub = getIntercomWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const updatedAt = new Date(conversation.data.updated_at * 1000).toISOString();
  const mapping = await findIntercomConversation(
    db,
    organizationId,
    conversation.data.id
  );

  if (mapping) {
    await stub.updateIssue(
      mapping.issueId,
      {
        title: conversationTitle(conversation.data),
        description: conversationBody(conversation.data) || undefined,
        status: intercomStateToVortexStatus(conversation.data.state),
        priority: intercomPriorityToVortexPriority(conversation.data.priority),
        updatedAt,
      },
      "intercom"
    );
  } else {
    const createdAt = new Date(
      conversation.data.created_at * 1000
    ).toISOString();
    const issue = await stub.createIssue(
      {
        id: `intercom:${organizationId}:${conversation.data.id}`,
        title: conversationTitle(conversation.data),
        description: conversationBody(conversation.data) || undefined,
        status: intercomStateToVortexStatus(conversation.data.state),
        priority: intercomPriorityToVortexPriority(conversation.data.priority),
        createdAt,
        updatedAt,
      },
      "intercom"
    );
    await createIntercomConversation(
      db,
      organizationId,
      conversation.data.id,
      issue.id
    );
  }
}

function getIntercomWorkspaceStub(env: WorkerEnv, organizationId: string) {
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  return env.WORKSPACE_DURABLE_OBJECT.get(doId);
}

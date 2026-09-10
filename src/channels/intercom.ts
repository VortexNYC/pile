import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { hmacSha1Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1, type D1Client } from "../global/db.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import { maybeEscalate } from "../global/support-escalation.js";
import {
  addTicketMessage,
  createTicket,
  findSupportTicketByExternalId,
  intercomStateToTicketStatus,
  stripHtml,
  updateTicket,
  type SupportTicketStatus,
} from "../global/support-tickets.js";
import {
  findWebhookDelivery,
  recordWebhookDelivery,
} from "../global/webhook-deliveries.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";

const intercomWebhookAuthorSchema = z.object({
  type: z.enum(["admin", "user", "lead", "bot", "contact"]),
  id: z.string(),
  name: z.string().nullable().default(null),
  email: z.string().email().nullable().default(null),
});

const intercomWebhookSourceSchema = z.object({
  type: z.string().default(""),
  subject: z.string().default(""),
  body: z.string().default(""),
  author: intercomWebhookAuthorSchema.nullable().default(null),
});

const intercomWebhookConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable().default(null),
  state: z.enum(["open", "closed", "snoozed"]).default("open"),
  priority: z
    .enum(["priority", "not_priority"])
    .optional()
    .default("not_priority"),
  source: intercomWebhookSourceSchema.nullable().default(null),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
});

const intercomNotificationSchema = z.object({
  type: z.literal("notification_event"),
  id: z.string(),
  topic: z.string(),
  app_id: z.string(),
  created_at: z.number().int(),
  data: z.object({
    item: z.unknown(),
  }),
});

export const intercomSupportWebhookRoute = createRoute({
  method: "post",
  path: "/support/webhooks/intercom/{organizationId}",
  tags: ["support-channels"],
  summary: "Receive Intercom support webhook notifications",
  middleware: [],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: z.unknown() } },
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
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

export async function processIntercomSupportWebhook(
  c: Context<AppContext>
): Promise<{ ok: boolean }> {
  const organizationId = c.req.param("organizationId");
  if (!organizationId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing organization ID",
    });
  }

  const secret = c.env.INTERCOM_CLIENT_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Intercom client secret is not configured",
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

  const parsed = safeJsonParse(rawBody);
  const notification = intercomNotificationSchema.safeParse(parsed);
  if (!notification.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Intercom notification",
      hint: notification.error.message,
    });
  }

  const { topic } = notification.data;
  if (topic === "ping" || !topic.startsWith("conversation.")) {
    return { ok: true };
  }

  const db = createD1(c.env.D1);
  const existingDelivery = await findWebhookDelivery(db, notification.data.id);
  if (existingDelivery) {
    return { ok: true };
  }

  const conversation = intercomWebhookConversationSchema.safeParse(
    notification.data.data.item
  );
  if (!conversation.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Intercom conversation payload",
      hint: conversation.error.message,
    });
  }

  const status = intercomStateToTicketStatus(conversation.data.state);
  const priority =
    conversation.data.priority === "priority" ? "high" : "medium";
  const source = conversation.data.source;
  const sourceAuthor = source?.author;
  const sourceBody = stripHtml(source?.body);
  const sourceSubject = source?.subject ?? "";

  if (topic.endsWith(".closed")) {
    await updateStatusIfExists(
      db,
      organizationId,
      conversation.data.id,
      "done"
    );
    await recordWebhookDelivery(
      db,
      notification.data.id,
      "intercom",
      topic,
      organizationId
    );
    return { ok: true };
  }
  if (topic.endsWith(".opened")) {
    await updateStatusIfExists(
      db,
      organizationId,
      conversation.data.id,
      "todo"
    );
    await recordWebhookDelivery(
      db,
      notification.data.id,
      "intercom",
      topic,
      organizationId
    );
    return { ok: true };
  }
  if (topic.endsWith(".snoozed")) {
    await updateStatusIfExists(
      db,
      organizationId,
      conversation.data.id,
      "snoozed"
    );
    await recordWebhookDelivery(
      db,
      notification.data.id,
      "intercom",
      topic,
      organizationId
    );
    return { ok: true };
  }

  const isAdminReply = topic.startsWith("conversation.admin.replied");
  const isUserReply = topic.startsWith("conversation.user.replied");
  const isCreated = topic.startsWith("conversation.user.created");

  if (!isCreated && !isUserReply && !isAdminReply) {
    await recordWebhookDelivery(
      db,
      notification.data.id,
      "intercom",
      topic,
      organizationId
    );
    return { ok: true };
  }

  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    conversation.data.id,
    "intercom"
  );

  const text = sourceBody || sourceSubject || "(no content)";
  const createdAt = conversation.data.created_at
    ? new Date(conversation.data.created_at * 1000).toISOString()
    : new Date().toISOString();

  if (existing) {
    if (isAdminReply) {
      await addTicketMessage(db, organizationId, existing.id, {
        direction: "outbound",
        textContent: text,
        channel: "intercom",
        actorType: "user",
        actorId: sourceAuthor?.id ?? null,
        subType: conversation.data.id,
        createdAt,
      });
    } else if (sourceAuthor?.email) {
      const customer = await findOrCreateCustomerByEmail(
        db,
        organizationId,
        sourceAuthor.email,
        sourceAuthor.name,
        "intercom"
      );
      await addTicketMessage(db, organizationId, existing.id, {
        direction: "inbound",
        textContent: text,
        channel: "intercom",
        customerId: customer.id,
        subType: conversation.data.id,
        createdAt,
      });
    }
    await updateTicket(db, organizationId, existing.id, {
      status,
      priority,
      actorType: "automation",
      actorId: null,
    });
    await recordWebhookDelivery(
      db,
      notification.data.id,
      "intercom",
      topic,
      organizationId
    );
    return { ok: true };
  }

  if (!sourceAuthor?.email) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing customer email in Intercom conversation",
    });
  }

  const customer = await findOrCreateCustomerByEmail(
    db,
    organizationId,
    sourceAuthor.email,
    sourceAuthor.name,
    "intercom"
  );

  const title =
    conversation.data.title ??
    (sourceSubject ||
      sourceBody.slice(0, 120) ||
      `Intercom conversation ${conversation.data.id}`);

  const ticket = await createTicket(db, {
    organizationId,
    customerId: customer.id,
    title,
    sourceChannel: "intercom",
    status,
    priority,
    externalId: conversation.data.id,
    externalSource: "intercom",
    createdAt,
    updatedAt: createdAt,
  });

  await maybeEscalate(c.env, db, organizationId, ticket, {
    text,
    subject: sourceSubject,
    customer,
    source: "intercom",
    channel: "intercom",
  });

  await addTicketMessage(db, organizationId, ticket.id, {
    direction: isAdminReply ? "outbound" : "inbound",
    textContent: text,
    channel: "intercom",
    customerId: customer.id,
    subType: conversation.data.id,
    createdAt,
  });

  await recordWebhookDelivery(
    db,
    notification.data.id,
    "intercom",
    topic,
    organizationId
  );
  return { ok: true };
}

async function updateStatusIfExists(
  db: D1Client,
  organizationId: string,
  externalId: string,
  status: SupportTicketStatus
): Promise<void> {
  const ticket = await findSupportTicketByExternalId(
    db,
    organizationId,
    externalId,
    "intercom"
  );
  if (ticket) {
    await updateTicket(db, organizationId, ticket.id, {
      status,
      actorType: "automation",
      actorId: null,
    });
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

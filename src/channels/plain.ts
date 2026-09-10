import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { hmacSha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1, type D1Client } from "../global/db.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import { maybeEscalate } from "../global/support-escalation.js";
import {
  addTicketMessage,
  createTicket,
  findSupportTicketByExternalId,
  stripHtml,
  updateTicket,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";

const plainCustomerSchema = z.object({
  id: z.string(),
  email: z.object({
    email: z.string().email(),
    isVerified: z.boolean().optional(),
  }),
  fullName: z.string().default(""),
  externalId: z.string().nullable().default(null),
});

const plainThreadSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  previewText: z.string().nullable().default(null),
  status: z.string().default("TODO"),
  priority: z.string().nullable().default(null),
  customer: plainCustomerSchema.nullable().default(null),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const plainEmailEntrySchema = z.object({
  id: z.string(),
  subject: z.string().nullable().default(null),
  textContent: z.string().nullable().default(null),
  markdownContent: z.string().nullable().default(null),
  from: z
    .object({
      email: z.string().email(),
      name: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  sentAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
});

const plainChatEntrySchema = z.object({
  chatId: z.string(),
  text: z.string().nullable().default(null),
  createdAt: z.string().datetime().optional(),
});

const plainWebhookPayloadSchema = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("thread.thread_created"),
    thread: plainThreadSchema,
  }),
  z.object({
    eventType: z.literal("thread.thread_status_transitioned"),
    previousThread: plainThreadSchema,
    thread: plainThreadSchema,
  }),
  z.object({
    eventType: z.literal("thread.thread_priority_changed"),
    previousThread: plainThreadSchema,
    thread: plainThreadSchema,
  }),
  z.object({
    eventType: z.literal("thread.email_received"),
    thread: plainThreadSchema,
    email: plainEmailEntrySchema,
  }),
  z.object({
    eventType: z.literal("thread.email_sent"),
    thread: plainThreadSchema,
    email: plainEmailEntrySchema,
  }),
  z.object({
    eventType: z.literal("thread.chat_received"),
    thread: plainThreadSchema,
    chat: plainChatEntrySchema,
  }),
  z.object({
    eventType: z.literal("thread.chat_sent"),
    thread: plainThreadSchema,
    chat: plainChatEntrySchema,
  }),
]);

const plainWebhookSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string().datetime(),
  workspaceId: z.string(),
  payload: plainWebhookPayloadSchema,
  webhookMetadata: z.unknown(),
});

export const plainSupportWebhookRoute = createRoute({
  method: "post",
  path: "/support/webhooks/plain/{organizationId}",
  tags: ["support-channels"],
  summary: "Receive Plain support webhook notifications",
  middleware: [],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: z.unknown() } },
      required: true,
    },
    headers: z.object({
      "plain-request-signature": z.string().optional(),
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

export async function processPlainSupportWebhook(
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

  const secret = c.env.PLAIN_WEBHOOK_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Plain webhook secret is not configured",
    });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("Plain-Request-Signature");
  if (!signature) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Missing Plain signature header",
    });
  }

  const computed = await hmacSha256Hex(secret, rawBody);
  if (!timingSafeEqualHex(signature.toLowerCase(), computed.toLowerCase())) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid Plain signature",
    });
  }

  const parsed = safeJsonParse(rawBody);
  const webhook = plainWebhookSchema.safeParse(parsed);
  if (!webhook.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Plain webhook payload",
      hint: webhook.error.message,
    });
  }

  const db = createD1(c.env.D1);
  const { payload } = webhook.data;

  switch (payload.eventType) {
    case "thread.thread_created":
      await createTicketFromPlainPayload(
        db,
        c.env,
        organizationId,
        payload.thread,
        {
          text: payload.thread.previewText ?? null,
        }
      );
      break;
    case "thread.thread_status_transitioned":
    case "thread.thread_priority_changed":
      await updatePlainTicket(db, organizationId, payload.thread);
      break;
    case "thread.email_received":
      await addMessageFromPlainPayload(
        db,
        c.env,
        organizationId,
        payload.thread,
        payload.email.textContent ?? payload.email.markdownContent ?? null,
        payload.email.from?.email ?? payload.thread.customer?.email.email,
        payload.email.from?.name ?? null,
        payload.email.id,
        "inbound"
      );
      break;
    case "thread.email_sent":
      await addMessageFromPlainPayload(
        db,
        c.env,
        organizationId,
        payload.thread,
        payload.email.textContent ?? payload.email.markdownContent ?? null,
        payload.email.from?.email ?? null,
        payload.email.from?.name ?? null,
        payload.email.id,
        "outbound"
      );
      break;
    case "thread.chat_received":
      await addMessageFromPlainPayload(
        db,
        c.env,
        organizationId,
        payload.thread,
        payload.chat.text,
        payload.thread.customer?.email.email ?? null,
        payload.thread.customer?.fullName ?? null,
        payload.chat.chatId,
        "inbound"
      );
      break;
    case "thread.chat_sent":
      await addMessageFromPlainPayload(
        db,
        c.env,
        organizationId,
        payload.thread,
        payload.chat.text,
        null,
        null,
        payload.chat.chatId,
        "outbound"
      );
      break;
    default:
      return { ok: true };
  }

  return { ok: true };
}

async function createTicketFromPlainPayload(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  thread: z.infer<typeof plainThreadSchema>,
  firstMessage: { text: string | null }
): Promise<void> {
  const customer = thread.customer;
  const email = customer?.email.email;
  if (!email) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing customer email in Plain thread",
    });
  }

  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    thread.id,
    "plain"
  );
  if (existing) {
    return;
  }

  const createdAt = thread.createdAt ?? new Date().toISOString();
  const status = plainStatusToTicketStatus(thread.status);
  const priority = plainPriorityToTicketPriority(thread.priority);
  const text = stripHtml(firstMessage.text) ?? "";
  const title =
    thread.title || text.slice(0, 120) || `Plain thread ${thread.id}`;

  const supportCustomer = await findOrCreateCustomerByEmail(
    db,
    organizationId,
    email,
    customer?.fullName ?? null,
    "plain"
  );

  const ticket = await createTicket(db, {
    organizationId,
    customerId: supportCustomer.id,
    title,
    sourceChannel: "plain",
    status,
    priority,
    externalId: thread.id,
    externalSource: "plain",
    createdAt,
    updatedAt: createdAt,
  });

  await maybeEscalate(env, db, organizationId, ticket, {
    text,
    subject: thread.title ?? undefined,
    customer: supportCustomer,
    source: "plain",
    channel: "plain",
  });

  if (text) {
    await addTicketMessage(db, organizationId, ticket.id, {
      direction: "inbound",
      textContent: text,
      channel: "plain",
      customerId: supportCustomer.id,
      subType: thread.id,
      createdAt,
    });
  }
}

async function updatePlainTicket(
  db: D1Client,
  organizationId: string,
  thread: z.infer<typeof plainThreadSchema>
): Promise<void> {
  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    thread.id,
    "plain"
  );
  if (!existing) {
    return;
  }
  const status = plainStatusToTicketStatus(thread.status);
  const priority = plainPriorityToTicketPriority(thread.priority);
  await updateTicket(db, organizationId, existing.id, {
    status,
    priority,
    actorType: "automation",
    actorId: null,
  });
}

async function addMessageFromPlainPayload(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  thread: z.infer<typeof plainThreadSchema>,
  text: string | null,
  fromEmail: string | null | undefined,
  fromName: string | null | undefined,
  externalMessageId: string,
  direction: "inbound" | "outbound"
): Promise<void> {
  let existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    thread.id,
    "plain"
  );

  if (!existing) {
    if (!fromEmail) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Missing customer email for new Plain thread",
      });
    }
    await createTicketFromPlainPayload(db, env, organizationId, thread, {
      text,
    });
    existing = await findSupportTicketByExternalId(
      db,
      organizationId,
      thread.id,
      "plain"
    );
    if (!existing) {
      return;
    }
  }

  const body = stripHtml(text) || "(no content)";
  const createdAt = thread.updatedAt ?? new Date().toISOString();

  if (direction === "outbound" || !fromEmail) {
    await addTicketMessage(db, organizationId, existing.id, {
      direction,
      textContent: body,
      channel: "plain",
      actorType: direction === "outbound" ? "user" : undefined,
      subType: externalMessageId,
      createdAt,
    });
    return;
  }

  const customer = await findOrCreateCustomerByEmail(
    db,
    organizationId,
    fromEmail,
    fromName ?? null,
    "plain"
  );
  await addTicketMessage(db, organizationId, existing.id, {
    direction: "inbound",
    textContent: body,
    channel: "plain",
    customerId: customer.id,
    subType: externalMessageId,
    createdAt,
  });
}

function plainStatusToTicketStatus(status: string): SupportTicketStatus {
  const map: Record<string, SupportTicketStatus> = {
    TODO: "todo",
    DONE: "done",
    SNOOZED: "snoozed",
  };
  return map[status.toUpperCase()] ?? "todo";
}

function plainPriorityToTicketPriority(
  priority: string | null
): SupportTicketPriority {
  const map: Record<string, SupportTicketPriority> = {
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    URGENT: "urgent",
  };
  return map[priority?.toUpperCase() ?? ""] ?? "medium";
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { hmacSha256Base64, timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
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
import type { AppContext } from "../platform/middleware.js";

const zendeskRequesterSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().default(null),
});

const zendeskTicketSchema = z.object({
  id: z.union([z.string(), z.number()]),
  subject: z.string().default(""),
  description: z.string().default(""),
  status: z.string().default("new"),
  priority: z.string().nullable().default(null),
  requester: zendeskRequesterSchema.nullable().default(null),
  updated_at: z.string().datetime().optional(),
  created_at: z.string().datetime().optional(),
});

const zendeskCommentSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  body: z.string().default(""),
  public: z.boolean().default(true),
  author_id: z.union([z.string(), z.number()]).optional(),
});

const zendeskWebhookPayloadSchema = z.object({
  ticket: zendeskTicketSchema.optional(),
  comment: zendeskCommentSchema.optional(),
});

export const zendeskSupportWebhookRoute = createRoute({
  method: "post",
  path: "/support/webhooks/zendesk/{organizationId}",
  tags: ["support-channels"],
  summary: "Receive Zendesk support webhook notifications",
  middleware: [],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: z.unknown() } },
      required: true,
    },
    headers: z.object({
      "x-zendesk-webhook-signature": z.string().optional(),
      "x-zendesk-webhook-signature-timestamp": z.string().optional(),
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

export async function processZendeskSupportWebhook(
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

  const secret = c.env.ZENDESK_WEBHOOK_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Zendesk webhook secret is not configured",
    });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Zendesk-Webhook-Signature");
  const timestamp = c.req.header("X-Zendesk-Webhook-Signature-Timestamp");
  if (!signature || !timestamp) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Missing Zendesk signature headers",
    });
  }

  const computed = await hmacSha256Base64(secret, timestamp + rawBody);
  if (!timingSafeEqualHex(signature, computed)) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid Zendesk signature",
    });
  }

  const parsed = safeJsonParse(rawBody);
  const payload = zendeskWebhookPayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid Zendesk webhook payload",
      hint: payload.error.message,
    });
  }

  const ticketData = payload.data.ticket;
  const comment = payload.data.comment;
  if (!ticketData) {
    return { ok: true };
  }

  const db = createD1(c.env.D1);
  const externalId = String(ticketData.id);
  const status = zendeskStatusToTicketStatus(ticketData.status);
  const priority = zendeskPriorityToTicketPriority(ticketData.priority);
  const requester = ticketData.requester;

  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    externalId,
    "zendesk"
  );

  const text = stripHtml(comment?.body ?? ticketData.description ?? "");
  const subject = ticketData.subject;
  const createdAt = ticketData.created_at ?? new Date().toISOString();

  if (existing) {
    if (requester?.email) {
      const customer = await findOrCreateCustomerByEmail(
        db,
        organizationId,
        requester.email,
        requester.name,
        "zendesk"
      );
      if (text) {
        await addTicketMessage(
          db,
          organizationId,
          existing.id,
          {
            direction: comment ? "outbound" : "inbound",
            textContent: text,
            channel: "zendesk",
            customerId: comment ? undefined : customer.id,
            actorType: comment ? "automation" : undefined,
            actorId: comment ? null : undefined,
            subType: comment ? String(comment.id ?? "") : externalId,
            externalId: comment ? String(comment.id ?? "") : externalId,
            createdAt,
          },
          c.env
        );
      }
    } else if (text) {
      await addTicketMessage(
        db,
        organizationId,
        existing.id,
        {
          direction: "inbound",
          textContent: text,
          channel: "zendesk",
          subType: externalId,
          externalId,
          createdAt,
        },
        c.env
      );
    }
    await updateTicket(
      db,
      organizationId,
      existing.id,
      {
        status,
        priority,
        actorType: "automation",
        actorId: null,
      },
      c.env
    );
    return { ok: true };
  }

  if (!requester?.email) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Missing requester email in Zendesk ticket",
    });
  }

  const customer = await findOrCreateCustomerByEmail(
    db,
    organizationId,
    requester.email,
    requester.name,
    "zendesk"
  );

  const title = subject || text.slice(0, 120) || `Zendesk ticket ${externalId}`;

  const ticket = await createTicket(
    db,
    {
      organizationId,
      customerId: customer.id,
      title,
      sourceChannel: "zendesk",
      status,
      priority,
      externalId,
      externalSource: "zendesk",
      createdAt,
      updatedAt: ticketData.updated_at ?? createdAt,
    },
    c.env
  );

  await maybeEscalate(c.env, db, organizationId, ticket, {
    text,
    subject: subject ?? undefined,
    customer,
    source: "zendesk",
    channel: "zendesk",
  });

  if (text) {
    await addTicketMessage(
      db,
      organizationId,
      ticket.id,
      {
        direction: "inbound",
        textContent: text,
        channel: "zendesk",
        customerId: customer.id,
        subType: externalId,
        externalId,
        createdAt,
      },
      c.env
    );
  }

  return { ok: true };
}

function zendeskStatusToTicketStatus(status: string): SupportTicketStatus {
  const solved: Record<string, SupportTicketStatus> = {
    new: "todo",
    open: "todo",
    pending: "todo",
    hold: "todo",
    solved: "done",
    closed: "done",
  };
  return solved[status.toLowerCase()] ?? "todo";
}

function zendeskPriorityToTicketPriority(
  priority: string | null
): SupportTicketPriority {
  const map: Record<string, SupportTicketPriority> = {
    low: "low",
    normal: "medium",
    high: "high",
    urgent: "urgent",
  };
  return map[priority?.toLowerCase() ?? ""] ?? "medium";
}

export async function sendZendeskMessage(input: {
  subdomain: string;
  accessToken: string;
  email: string;
  ticketId: string;
  text: string;
}): Promise<boolean> {
  try {
    const auth = btoa(`${input.email}/token:${input.accessToken}`);
    const res = await fetch(
      `https://${input.subdomain}.zendesk.com/api/v2/tickets/${input.ticketId}.json`,
      {
        method: "PUT",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticket: {
            comment: { body: input.text, public: true },
          },
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

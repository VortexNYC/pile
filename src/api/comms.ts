import { createHmac, timingSafeEqual } from "node:crypto";

import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  commsIntegrations,
  supportCustomerEvents,
  supportCustomers,
} from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

function notFound(message = "Not found"): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}
function unauthorized(message = "Unauthorized"): never {
  throw new VortexError({ code: "UNAUTHORIZED", status: 401, message });
}

// Comms events — the CRM ledger. External systems (cal.com, calendar,
// email later) stream events IN; Pile stores them on the contact but
// never owns the channel.

const eventSchema = z.object({
  type: z.enum(["booking", "call", "meeting", "email", "note", "custom"]),
  summary: z.string().min(1),
  externalId: z.string().optional(),
  payload: z.string().optional(),
  occurredAt: z.string().optional(),
});

const customerIdParam = z.object({
  organizationId: z.string(),
  customerId: z.string(),
});

const listEventsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/customers/{customerId}/events",
  tags: ["comms"],
  middleware: [rls("ticket:view")],
  request: {
    params: customerIdParam,
    query: z.object({ limit: z.coerce.number().default(20) }),
  },
  responses: {
    200: {
      description: "Recent comms events for a support customer",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                source: z.string(),
                summary: z.string(),
                occurredAt: z.string(),
                createdAt: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

const createEventRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/customers/{customerId}/events",
  tags: ["comms"],
  middleware: [rls("ticket:create")],
  request: {
    params: customerIdParam,
    body: { content: { "application/json": { schema: eventSchema } } },
  },
  responses: {
    201: {
      description: "Event recorded",
      content: {
        "application/json": { schema: z.object({ id: z.string() }) },
      },
    },
  },
});

// The integration is configured per-source: PUT sets the webhook
// secret cal.com (or gcal, …) sends on every delivery.
const upsertIntegrationRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/comms/integrations/{source}",
  tags: ["comms"],
  middleware: [rls("settings:edit")],
  request: {
    params: z.object({
      organizationId: z.string(),
      source: z.enum(["calcom", "gcal", "email"]),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            webhookSecret: z.string().min(1),
            config: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Integration configured",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

// Inbound webhook — cal.com posts bookings here; verified by shared
// secret (their X-Cal-Signature-256 HMAC or our x-pile-webhook-secret).
const webhookRoute = createRoute({
  security: [],
  method: "post",
  path: "/webhooks/comms/{organizationId}/{source}",
  tags: ["comms"],
  request: {
    params: z.object({
      organizationId: z.string(),
      source: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()).optional(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: {
        "application/json": { schema: z.object({ recorded: z.number() }) },
      },
    },
    401: { description: "Bad secret" },
    404: { description: "Integration not configured" },
  },
});

// ---- cal.com payload parsing ----

interface CalBooking {
  uid?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  attendees?: Array<{ email?: string; name?: string }>;
  organizer?: { email?: string };
}

function parseCalcom(body: Record<string, unknown>): {
  type: string;
  summary: string;
  externalId: string | undefined;
  emails: string[];
  occurredAt: string;
} | null {
  const trigger = body.triggerEvent as string | undefined;
  const payload = (body.payload ?? body) as Record<string, unknown>;
  const booking = payload as CalBooking;
  const title = booking.title ?? "Booking";
  const externalId = booking.uid;
  const occurredAt = booking.startTime ?? new Date().toISOString();
  const emails = [
    ...(booking.attendees ?? [])
      .map((a) => a.email)
      .filter((e): e is string => !!e),
    ...(booking.organizer?.email ? [booking.organizer.email] : []),
  ];
  const type =
    trigger === "BOOKING_CANCELLED" || trigger === "BOOKING_REJECTED"
      ? "call"
      : "booking";
  const summary =
    trigger === "BOOKING_CANCELLED"
      ? `Call canceled: ${title}`
      : trigger === "BOOKING_REJECTED"
        ? `Booking rejected: ${title}`
        : trigger === "BOOKING_RESCHEDULED"
          ? `Call rescheduled: ${title}`
          : `Call booked: ${title}`;
  return { type, summary, externalId, emails, occurredAt };
}

function verifyCalSignature(
  secret: string,
  body: string,
  signature: string | undefined,
  header: string | undefined
) {
  if (header === secret) return true;
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function registerCommsRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listEventsRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const events = await db
      .select({
        id: supportCustomerEvents.id,
        type: supportCustomerEvents.type,
        source: supportCustomerEvents.source,
        summary: supportCustomerEvents.summary,
        occurredAt: supportCustomerEvents.occurredAt,
        createdAt: supportCustomerEvents.createdAt,
      })
      .from(supportCustomerEvents)
      .where(
        and(
          eq(supportCustomerEvents.supportCustomerId, customerId),
          eq(supportCustomerEvents.organizationId, organizationId)
        )
      )
      .orderBy(desc(supportCustomerEvents.occurredAt))
      .limit(limit)
      .all();
    return c.json({ events });
  });

  app.openapi(createEventRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const customer = await db
      .select({ id: supportCustomers.id })
      .from(supportCustomers)
      .where(
        and(
          eq(supportCustomers.id, customerId),
          eq(supportCustomers.organizationId, organizationId)
        )
      )
      .get();
    if (!customer) return notFound("Customer not found");
    const id = crypto.randomUUID();
    await db.insert(supportCustomerEvents).values({
      id,
      organizationId,
      supportCustomerId: customerId,
      type: body.type,
      source: "manual",
      externalId: body.externalId ?? null,
      summary: body.summary,
      payload: body.payload ?? null,
      occurredAt: body.occurredAt ?? new Date().toISOString(),
    });
    return c.json({ id }, 201);
  });

  app.openapi(upsertIntegrationRoute, async (c) => {
    const { organizationId, source } = c.req.valid("param");
    const { webhookSecret, config } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const existing = await db
      .select({ id: commsIntegrations.id })
      .from(commsIntegrations)
      .where(
        and(
          eq(commsIntegrations.organizationId, organizationId),
          eq(commsIntegrations.source, source)
        )
      )
      .get();
    const now = new Date().toISOString();
    if (existing) {
      await db
        .update(commsIntegrations)
        .set({ webhookSecret, config: config ?? null, updatedAt: now })
        .where(eq(commsIntegrations.id, existing.id));
    } else {
      await db.insert(commsIntegrations).values({
        id: crypto.randomUUID(),
        organizationId,
        source,
        webhookSecret,
        config: config ?? null,
      });
    }
    return c.json({ ok: true });
  });

  app.openapi(webhookRoute, async (c) => {
    const { organizationId, source } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const integration = await db
      .select()
      .from(commsIntegrations)
      .where(
        and(
          eq(commsIntegrations.organizationId, organizationId),
          eq(commsIntegrations.source, source),
          eq(commsIntegrations.isActive, true)
        )
      )
      .get();
    if (!integration?.webhookSecret) {
      return notFound("Integration not configured");
    }
    const raw = await c.req.text();
    const ok = verifyCalSignature(
      integration.webhookSecret,
      raw,
      c.req.header("x-cal-signature-256"),
      c.req.header("x-pile-webhook-secret")
    );
    if (!ok) return unauthorized("Invalid webhook secret");

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return unauthorized("Invalid JSON");
    }

    const events: Array<{
      type: string;
      summary: string;
      externalId: string | undefined;
      email: string;
      occurredAt: string;
    }> = [];

    if (source === "calcom") {
      const parsed = parseCalcom(body);
      if (!parsed) return c.json({ recorded: 0 });
      for (const email of parsed.emails) {
        events.push({ ...parsed, email });
      }
    } else {
      return c.json({ recorded: 0 });
    }

    const results = await Promise.all(
      events.map(async (event) => {
        const customer = await db
          .select({ id: supportCustomers.id })
          .from(supportCustomers)
          .where(
            and(
              eq(supportCustomers.organizationId, organizationId),
              eq(supportCustomers.email, event.email)
            )
          )
          .get();
        if (!customer) return false;
        await db
          .insert(supportCustomerEvents)
          .values({
            id: crypto.randomUUID(),
            organizationId,
            supportCustomerId: customer.id,
            type: event.type,
            source,
            externalId: event.externalId ?? null,
            summary: event.summary,
            payload: raw,
            occurredAt: event.occurredAt,
          })
          .onConflictDoNothing();
        return true;
      })
    );
    return c.json({ recorded: results.filter(Boolean).length });
  });
}

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { supportCustomerEvents } from "../global/schema.js";
import {
  createCustomer,
  getCustomerByEmail,
} from "../global/support-contacts.js";
import { runTriageRules } from "../global/triage-rules.js";
import type { AppContext } from "../platform/middleware.js";
import { publicRateLimit } from "../platform/rate-limit.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { getWorkspaceStub } from "./stub.js";

const leadSchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
  company: z.string().optional(),
  dealName: z.string().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  message: z.string().optional(),
  source: z.string().default("form"),
});

const leadRoute = createRoute({
  security: [],
  method: "post",
  path: "/public/leads/{organizationId}",
  tags: ["leads"],
  middleware: [publicRateLimit({ bucket: "leads", max: 30 })],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: leadSchema } } },
  },
  responses: {
    201: {
      description: "Lead accepted",
      content: {
        "application/json": {
          schema: z.object({
            customerId: z.string(),
            dealId: z.string().optional(),
          }),
        },
      },
    },
  },
});

/** Inbound lead forms — a public endpoint that creates the contact,
 * optionally a deal, and a comms event. The form lives on your site;
 * Pile owns the record. */
export function registerLeadRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(leadRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await getCustomerByEmail(db, organizationId, body.email);
    const customer =
      existing ??
      (await createCustomer(db, {
        organizationId,
        email: body.email.trim().toLowerCase(),
        fullName: body.fullName?.trim() || null,
        externalSource: body.source,
      }));

    let dealId: string | undefined;
    if (body.dealName) {
      const stub = getWorkspaceStub(c.env, organizationId);
      await stub.setOrganizationId(organizationId);
      const deal = await stub.createDeal({
        customerId: customer.id,
        name: body.dealName,
        stage: "lead",
        amountCents: body.amountCents ?? null,
        currency: body.currency ?? null,
        contactIds: [customer.id],
      });
      dealId = deal.id;
    }

    const summary = [
      "Lead via",
      body.source,
      body.company ? `— ${body.company}` : "",
      body.message ? `: ${body.message.slice(0, 140)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    await db.insert(supportCustomerEvents).values({
      id: crypto.randomUUID(),
      organizationId,
      supportCustomerId: customer.id,
      type: "custom",
      source: body.source,
      summary,
      payload: JSON.stringify({
        kind: "lead",
        company: body.company ?? null,
        message: body.message ?? null,
        dealId: dealId ?? null,
      }),
      occurredAt: new Date().toISOString(),
    });

    // PILE-427 — inbound lead: triage rules decide delegation (e.g. a
    // website-form lead auto-delegated to Scout/Profiler). The evaluation
    // lands in the triage log either way.
    await runTriageRules(
      c.env,
      db,
      organizationId,
      {
        recordType: "lead",
        recordId: customer.id,
        title: `Lead: ${body.company ?? body.fullName ?? body.email}`,
        text: [body.fullName, body.company, body.dealName, body.message]
          .filter((part): part is string => Boolean(part))
          .join("\n"),
        source: body.source,
        customerEmail: body.email,
        dealId: dealId ?? null,
        fields: {
          email: body.email,
          fullName: body.fullName ?? null,
          company: body.company ?? null,
          dealName: body.dealName ?? null,
          amountCents: body.amountCents ?? null,
          currency: body.currency ?? null,
          source: body.source,
        },
      },
      { ctx: getExecutionCtx(c) }
    );

    return c.json({ customerId: customer.id, dealId }, 201);
  });
}

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { billingAccounts } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";

const TOLERANCE_MS = 5 * 60 * 1000;

/** Vortex-Signature: "t=<ms>,v1=<hex>[,v1=<hex>...]" — HMAC-SHA256 over "{t}.{body}". */
async function verifySignature(
  secret: string,
  header: string,
  payload: Uint8Array
): Promise<boolean> {
  let ts = 0;
  const sigs: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") ts = Number(v);
    if (k === "v1") {
      const bytes = new Uint8Array(v.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
      }
      sigs.push(bytes);
    }
  }
  if (!ts || sigs.length === 0) return false;
  if (Math.abs(Date.now() - ts) > TOLERANCE_MS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const prefix = new TextEncoder().encode(`${ts}.`);
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix);
  signed.set(payload, prefix.length);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, signed)
  );
  for (const sig of sigs) {
    if (
      sig.length === expected.length &&
      sig.every((b, i) => b === expected[i])
    )
      return true;
  }
  return false;
}

const webhookEventSchema = z.object({
  type: z.string(),
  data: z
    .object({
      externalCustomerRef: z.string().optional(),
      status: z.string().optional(),
      currentPeriodEnd: z.string().optional(),
    })
    .passthrough(),
});

const billingWebhookRoute = createRoute({
  method: "post",
  path: "/billing/webhook",
  tags: ["billing"],
  request: {
    body: { content: { "application/json": { schema: webhookEventSchema } } },
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

export function registerBillingWebhookRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(billingWebhookRoute, async (c) => {
    const secret = c.env.BILLING_WEBHOOK_SECRET;
    if (!secret) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Billing webhooks not configured",
      });
    }
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    const header = c.req.header("Vortex-Signature") ?? "";
    if (!(await verifySignature(secret, header, raw))) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid webhook signature",
      });
    }
    const event = webhookEventSchema.parse(
      JSON.parse(new TextDecoder().decode(raw))
    );
    const organizationId = event.data.externalCustomerRef;
    if (!organizationId) return c.json({ ok: true }, 200);

    const db = createD1(c.env.D1);
    const ts = new Date().toISOString();
    const grant =
      event.type.startsWith("entitlement.granted") ||
      event.type.startsWith("subscription.activated");
    const revoke =
      event.type.startsWith("entitlement.revoked") ||
      event.type.startsWith("subscription.canceled");
    if (!grant && !revoke) return c.json({ ok: true }, 200);

    const existing = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();
    const plan = grant ? "paid" : "free";
    const status = grant
      ? "active"
      : revoke
        ? "canceled"
        : (existing?.status ?? "active");
    if (existing) {
      await db
        .update(billingAccounts)
        .set({
          plan,
          status,
          currentPeriodEnd:
            event.data.currentPeriodEnd ?? existing.currentPeriodEnd,
          updatedAt: ts,
        })
        .where(eq(billingAccounts.organizationId, organizationId));
    } else {
      await db.insert(billingAccounts).values({
        organizationId,
        plan,
        status,
        currentPeriodEnd: event.data.currentPeriodEnd ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return c.json({ ok: true }, 200);
  });
}

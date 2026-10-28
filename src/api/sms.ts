import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { drainDomainEvents } from "../agents/pipeline-events.js";
import { timingSafeEqualHex } from "../global/crypto.js";
import type { AppContext } from "../platform/middleware.js";
import { publicRateLimit } from "../platform/rate-limit.js";
import type { CustomerTouchOutcome } from "../workspace/touch-outcomes.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { getWorkspaceStub } from "./stub.js";

// PILE-395 — SMS agent: employees text a dedicated number (Sendblue /
// Twilio-style inbound webhook) and a deterministic parser performs CRM
// ops — find-or-create the customer by sender phone, log the knock,
// bridge quoted $ into a proposal deal, schedule the follow-up, and
// answer "what's due" with the rep's pending list. No LLM call for v1.

const DAY_MS = 86_400_000;
const SMS_ACTOR_ID = "sms-inbound";

const smsInboundBodySchema = z.object({
  // Sender phone number (E.164, e.g. "+15551234567"). Kept permissive —
  // providers also send shortcodes and bare national numbers.
  from: z.string().trim().min(4).max(40),
  text: z.string().trim().min(1).max(2000),
  to: z.string().trim().max(40).optional(),
  messageId: z.string().trim().max(200).optional(),
  receivedAt: z.string().optional(),
});

const smsErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const smsCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  statusId: z.string().nullable(),
  nextStepText: z.string().nullable(),
  nextStepDueAt: z.string().nullable(),
});

const dueItemSchema = z.object({
  customerId: z.string(),
  name: z.string(),
  nextStepText: z.string().nullable(),
  nextStepDueAt: z.string().nullable(),
});

const smsActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("interaction_logged"),
    interactionId: z.string(),
    outcome: z.string(),
  }),
  z.object({
    type: z.literal("deal_created"),
    dealId: z.string(),
    amountCents: z.number(),
  }),
  z.object({
    type: z.literal("follow_up_set"),
    nextStepDueAt: z.string(),
    nextStepText: z.string().nullable(),
  }),
  z.object({
    type: z.literal("due_list"),
    items: z.array(dueItemSchema),
  }),
]);

const smsInboundResponseSchema = z.object({
  ok: z.literal(true),
  deduplicated: z.boolean(),
  customer: smsCustomerSchema.nullable(),
  actions: z.array(smsActionSchema),
  // Canonical SMS reply — a provider reply webhook can send this verbatim.
  replyText: z.string(),
});

// ---- deterministic parse helpers ----

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** Two phone strings match when their digits are equal or their last-10
 *  (national) digits agree — "+15551234567" ≡ "555-123-4567". */
function phonesMatch(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length >= 10 && db.length >= 10) {
    return da.slice(-10) === db.slice(-10);
  }
  return false;
}

const ADDRESS_RE =
  /\b(\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+)*?\s(?:ave(?:nue)?|st(?:reet)?|rd|road|blvd|dr(?:ive)?|ln|lane|ct|court|pl|place|way|ter(?:race)?))\b/i;

function extractAddress(text: string): string | undefined {
  return ADDRESS_RE.exec(text)?.[1]?.trim();
}

const PERSON_NAME_RE =
  /\b(?:talked|spoke|met)\s+(?:to|with)\s+([A-Z][A-Za-z'-]{1,30})/;

function extractPersonName(text: string): string | undefined {
  return PERSON_NAME_RE.exec(text)?.[1];
}

/** Quoted dollar amount → cents. Matches "$225", "225/mo", and a bare
 *  number following a quote keyword ("quoted 1200"). */
function extractQuotedAmountCents(text: string): number | undefined {
  const dollar = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/.exec(text);
  if (dollar?.[1]) {
    return Math.round(Number.parseFloat(dollar[1].replace(/,/g, "")) * 100);
  }
  const monthly =
    /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/\s*mo(?:nth)?|per month|a month|monthly)\b/i.exec(
      text
    );
  if (monthly?.[1]) {
    return Math.round(Number.parseFloat(monthly[1].replace(/,/g, "")) * 100);
  }
  const quoted =
    /\b(?:quoted|quote|price|priced|rate)\b[^\d]{0,20}(\d[\d,]*(?:\.\d{1,2})?)/i.exec(
      text
    );
  if (quoted?.[1]) {
    return Math.round(Number.parseFloat(quoted[1].replace(/,/g, "")) * 100);
  }
  return undefined;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const FOLLOW_UP_TRIGGER_RE =
  /\b(follow[\s-]?up|follow|call[\s-]?back|remind)\b/i;

/** Follow-up due date from the text — only when a follow-up/callback/
 *  remind trigger word is present. Handles ISO dates, "in N days",
 *  "tomorrow", "next week", and weekday names (next occurrence). */
function parseFollowUpDueAt(text: string, now: Date): string | undefined {
  if (!FOLLOW_UP_TRIGGER_RE.test(text)) return undefined;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso?.[1]) {
    const parsed = new Date(`${iso[1]}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (/\bnext week\b/i.test(text)) {
    return new Date(now.getTime() + 7 * DAY_MS).toISOString();
  }
  const inDays = /\bin\s+(\d{1,30})\s+days?\b/i.exec(text);
  if (inDays?.[1]) {
    return new Date(
      now.getTime() + Number.parseInt(inDays[1], 10) * DAY_MS
    ).toISOString();
  }
  if (/\btomorrow\b/i.test(text)) {
    return new Date(now.getTime() + DAY_MS).toISOString();
  }
  const weekday =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(
      text
    );
  if (weekday?.[1]) {
    const target = WEEKDAYS[weekday[1].toLowerCase()]!;
    let delta = (target - now.getUTCDay() + 7) % 7;
    // "Friday" on a Friday means next week's — a same-day reminder is
    // useless once the rep is already back at the truck.
    if (delta === 0) delta = 7;
    return new Date(now.getTime() + delta * DAY_MS).toISOString();
  }
  return undefined;
}

const KNOCK_RE = /\b(knocked|knock|visited|spoke|talked|met)\b/i;
const QUOTE_RE = /\b(quoted|quote)\b/i;
// "due" as a noun and plural "follow-ups"/"followups" are the rep asking
// for their list — singular "follow up friday" stays a command.
const DUE_RE = /\b(what'?s due|what is due|due|follow-?ups|followups)\b/i;

function toCustomerProjection(row: {
  id: string;
  name: string;
  phone: string | null;
  statusId: string | null;
  nextStepText: string | null;
  nextStepDueAt: string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    statusId: row.statusId,
    nextStepText: row.nextStepText,
    nextStepDueAt: row.nextStepDueAt,
  };
}

const smsInboundRoute = createRoute({
  security: [],
  method: "post",
  path: "/workspaces/{organizationId}/customers/sms-inbound",
  tags: ["customers"],
  middleware: [publicRateLimit({ bucket: "sms-inbound", max: 60 })],
  description:
    "Inbound SMS agent webhook (PILE-395). An SMS provider (Sendblue-style) POSTs each inbound text; a deterministic parser performs CRM ops on the sender's customer record — knock/visit logging, quoted-$ → proposal deal, follow-up scheduling, and 'what's due' list. Auth is a shared webhook secret via ?secret= or the x-sms-secret header compared against SMS_INBOUND_SECRET; the endpoint refuses (503 NOT_CONFIGURED) when the secret is unset so inbound is never unauthenticated. Retries dedupe on messageId.",
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: smsInboundBodySchema } },
    },
  },
  responses: {
    200: {
      description: "SMS interpreted — actions taken plus the SMS reply text",
      content: { "application/json": { schema: smsInboundResponseSchema } },
    },
    401: {
      description: "Missing or invalid webhook secret",
      content: { "application/json": { schema: smsErrorSchema } },
    },
    503: {
      description: "SMS_INBOUND_SECRET not configured",
      content: { "application/json": { schema: smsErrorSchema } },
    },
  },
});

export function registerSmsRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(smsInboundRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");

    // Shared-secret auth — ?secret=, x-sms-secret, or Authorization:
    // Bearer — timing-safe compared. Unset secret = feature off, never
    // silently open. The Bearer channel doubles as the CSRF pass-through:
    // csrfMiddleware skips the origin check for bearer-credentialed POSTs
    // (same pattern as the agent-session webhook routes), so a provider
    // posting with only ?secret=/x-sms-secret also needs its path
    // whitelisted in isPublicPath for non-browser callers.
    const expected =
      typeof c.env.SMS_INBOUND_SECRET === "string"
        ? c.env.SMS_INBOUND_SECRET
        : undefined;
    if (!expected) {
      return c.json(
        {
          code: "NOT_CONFIGURED",
          message: "SMS inbound webhook is not configured",
        },
        503
      );
    }
    const bearer = c.req.header("authorization")?.trim() ?? "";
    const provided = (
      c.req.query("secret") ??
      c.req.header("x-sms-secret") ??
      (/^Bearer\s+/i.test(bearer) ? bearer.replace(/^Bearer\s+/i, "") : "")
    ).trim();
    if (!provided || !timingSafeEqualHex(provided, expected)) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Invalid SMS webhook secret" },
        401
      );
    }

    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const phone = normalizePhone(input.from);
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : null;
    const now =
      receivedAt && !Number.isNaN(receivedAt.getTime())
        ? receivedAt
        : new Date();
    const nowIso = now.toISOString();

    const findByPhone = async () =>
      (await stub.listCustomers()).find(
        (row) => row.phone && phonesMatch(row.phone, phone)
      );

    // Provider retry dedupe — the memory claim is atomic inside one DO
    // turn, so a retried webhook never double-logs.
    if (input.messageId) {
      const claimed = await stub.claimMemoryOnce({
        entityType: "sms",
        entityId: `sms:${input.messageId}`,
        kind: "inbound_dedupe",
        fact: `${phone} ${input.text.slice(0, 200)}`,
      });
      if (!claimed) {
        const existing = await findByPhone();
        return c.json(
          {
            ok: true as const,
            deduplicated: true,
            customer: existing ? toCustomerProjection(existing) : null,
            actions: [],
            replyText: "Already processed that message — skipped.",
          },
          200
        );
      }
    }

    // Find-or-create the sender's customer record. externalId is a hard
    // dedupe key, so a retried/raced create still lands on one row.
    let customer = await findByPhone();
    if (!customer) {
      customer = await stub.createCustomer({
        name:
          extractPersonName(input.text) ?? extractAddress(input.text) ?? phone,
        phone,
        source: "sms_inbound",
        externalId: `sms:${phone.replace(/\D/g, "")}`,
      });
    }

    // Lossless raw log — every inbound text lands as an sms-channel
    // interaction note on the customer, parsed intent or not.
    await stub.memoryRemember({
      entityType: "customer",
      entityId: customer.id,
      kind: "sms_inbound",
      fact: JSON.stringify({
        channel: "sms",
        direction: "inbound",
        from: phone,
        to: input.to ?? null,
        text: input.text,
        messageId: input.messageId ?? null,
        receivedAt: input.receivedAt ?? nowIso,
      }),
    });

    const text = input.text;
    const knockIntent = KNOCK_RE.test(text);
    const amountCents = extractQuotedAmountCents(text);
    const quoteIntent = amountCents !== undefined || QUOTE_RE.test(text);
    const followUpDueAt = parseFollowUpDueAt(text, now);
    const dueIntent = DUE_RE.test(text);

    const actions: z.infer<typeof smsActionSchema>[] = [];
    const replyParts: string[] = [];

    // One outcome per text — the strongest signal wins, same
    // outcome→stage/next-step machinery as the quick-knock route.
    let outcome: CustomerTouchOutcome | undefined;
    if (quoteIntent) outcome = "quoted";
    else if (knockIntent) outcome = "talked";
    else if (followUpDueAt) outcome = "callback";

    if (outcome) {
      const result = await stub.logCustomerInteraction(
        customer.id,
        {
          outcome,
          note: text,
          nextStepDueAt: followUpDueAt,
        },
        SMS_ACTOR_ID
      );
      if (result) {
        customer = result.customer;
        actions.push({
          type: "interaction_logged",
          interactionId: result.interactionId,
          outcome,
        });
        const what = knockIntent ? "knock" : quoteIntent ? "quote" : "callback";
        const where = extractAddress(text) ?? customer.name;
        replyParts.push(`Logged ${what} on ${where}.`);
      }
    } else if (!dueIntent) {
      replyParts.push(`Logged note for ${customer.name}.`);
    }

    // Quoted at the door → proposal-stage deal, same bridge as
    // quick-knock's quotedAmountCents.
    if (amountCents !== undefined) {
      try {
        const deal = await stub.createDeal({
          customerId: customer.id,
          name: `${customer.name} — Quote`,
          stage: "proposal",
          amountCents,
          currency: "USD",
        });
        actions.push({
          type: "deal_created",
          dealId: deal.id,
          amountCents,
        });
        const dollars = (amountCents / 100).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        });
        replyParts.push(`Quoted $${dollars} → deal created.`);
      } catch {
        // Deal bridge is best-effort — the touch already landed.
      }
    }

    if (followUpDueAt) {
      actions.push({
        type: "follow_up_set",
        nextStepDueAt: followUpDueAt,
        nextStepText: customer.nextStepText,
      });
      const day = WEEKDAY_NAMES[new Date(followUpDueAt).getUTCDay()]!;
      replyParts.push(`Follow-up ${day} ${followUpDueAt.slice(0, 10)}.`);
    }

    if (dueIntent) {
      const due = (await stub.listCustomers({ dueBefore: nowIso }))
        .filter((row) => row.nextStepDueAt !== null)
        .slice(0, 5);
      const items = due.map((row) => ({
        customerId: row.id,
        name: row.name,
        nextStepText: row.nextStepText,
        nextStepDueAt: row.nextStepDueAt,
      }));
      actions.push({ type: "due_list", items });
      replyParts.push(
        items.length === 0
          ? "Nothing due."
          : `Due: ${items
              .map(
                (item) =>
                  `${item.name} (${item.nextStepText ?? "follow up"}, ${item.nextStepDueAt?.slice(0, 10)})`
              )
              .join("; ")}.`
      );
    }

    // Stage auto-advance emits record.stage_entered — drain into
    // dispatches like the other customer write paths.
    getExecutionCtx(c)?.waitUntil(
      drainDomainEvents(c.env, stub, organizationId, getExecutionCtx(c))
    );

    return c.json(
      {
        ok: true as const,
        deduplicated: false,
        customer: toCustomerProjection(customer),
        actions,
        replyText:
          replyParts.length > 0
            ? replyParts.join(" ")
            : `Logged note for ${customer.name}.`,
      },
      200
    );
  });
}

import { and, eq } from "drizzle-orm";

import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";

// Deployment env for the sms concierge — set as worker secrets/vars.
export interface SmsEnv {
  SENDBLUE_API_KEY?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  SMS_ORGANIZATION_ID?: string;
  SMS_AGENT_MODEL?: string;
  DEVIN_TOKEN?: string;
  DEVIN_ORG_ID?: string;
  PUBLIC_API_URL?: string;
  BETTER_AUTH_URL?: string;
}
type SmsWorkerEnv = WorkerEnv & SmsEnv;
import { VortexError } from "../platform/errors.js";
import {
  member as memberTable,
  organization,
  supportCustomers,
  supportSmsThreads,
} from "./schema.js";
import { findOrCreateCustomerByEmail } from "./support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  type SupportTicketEventWithDetails,
} from "./support-tickets.js";

export type SmsInboundBody = {
  from_number: string;
  to_number?: string;
  content?: string;
  media_url?: string;
  service?: string;
  date_sent?: string;
};

export function normalizePhoneForApi(raw: string): string {
  return normalizePhone(raw);
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^+0-9]/g, "");
  return digits;
}

/** Find the thread row for a phone number — one ticket + one Devin
 * session per sms conversation. */
export async function getSmsThread(
  db: D1Client,
  organizationId: string,
  phone: string,
  groupId?: string | null
) {
  const normalized = normalizePhone(phone);
  const [row] = await db
    .select()
    .from(supportSmsThreads)
    .where(
      and(
        eq(supportSmsThreads.organizationId, organizationId),
        groupId
          ? eq(supportSmsThreads.groupId, groupId)
          : eq(supportSmsThreads.phone, normalized)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Phone → customer. No email on sms senders — the number is the key.
 * The email column is required so the customer gets a stable synthetic
 * one keyed on the number. */
export async function findOrCreateCustomerByPhone(
  db: D1Client,
  organizationId: string,
  phone: string
) {
  const normalized = normalizePhone(phone);
  const [existing] = await db
    .select()
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.phone, normalized)
      )
    )
    .limit(1);
  if (existing) return existing;
  const syntheticEmail = `${normalized.replace(/^\+/, "")}@sms.pile`;
  return findOrCreateCustomerByEmail(
    db,
    organizationId,
    syntheticEmail,
    normalized,
    "sms"
  ).then(async (customer) => {
    await db
      .update(supportCustomers)
      .set({ phone: normalized })
      .where(eq(supportCustomers.id, customer.id))
      .run();
    return { ...customer, phone: normalized };
  });
}

/** The org a text belongs to — the workspace that owns the configured
 * Sendblue number. For v1 the number is single-tenant per workspace:
 * the org whose `metadata.smsNumber` matches `to_number` wins. When no
 * org declares one, `SMS_ORGANIZATION_ID` pins the deployment's tenant. */
export async function resolveSmsOrganization(
  db: D1Client,
  toNumber: string | undefined,
  env: SmsWorkerEnv
): Promise<string | null> {
  if (env.SMS_ORGANIZATION_ID) return env.SMS_ORGANIZATION_ID;
  if (!toNumber) return null;
  const normalized = normalizePhone(toNumber);
  const orgs = await db
    .select({ id: organization.id, metadata: organization.metadata })
    .from(organization)
    .all();
  for (const org of orgs) {
    try {
      const meta = org.metadata ? JSON.parse(org.metadata) : {};
      if (
        typeof meta.smsNumber === "string" &&
        normalizePhone(meta.smsNumber) === normalized
      ) {
        return org.id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Sendblue send — the same shape staff's sendblue package uses. */
export async function sendSms(
  env: SmsWorkerEnv,
  toNumber: string,
  content: string
) {
  const apiKey = env.SENDBLUE_API_KEY;
  const apiSecret = env.SENDBLUE_API_SECRET;
  const fromNumber = env.SENDBLUE_FROM_NUMBER;
  if (!apiKey || !apiSecret || !fromNumber) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Sendblue credentials are not configured",
    });
  }
  const res = await fetch("https://api.sendblue.co/api/send-message", {
    method: "POST",
    headers: {
      "sb-api-key-id": apiKey,
      "sb-api-secret-key": apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      number: toNumber,
      from_number: fromNumber,
      content,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new VortexError({
      code: "AGENT_ERROR",
      status: 502,
      message: `Sendblue send failed: ${res.status} ${body}`,
    });
  }
  return res.json();
}

export async function sendGroupSms(
  env: SmsWorkerEnv,
  groupId: string,
  content: string
) {
  const apiKey = env.SENDBLUE_API_KEY;
  const apiSecret = env.SENDBLUE_API_SECRET;
  const fromNumber = env.SENDBLUE_FROM_NUMBER;
  if (!apiKey || !apiSecret || !fromNumber) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Sendblue credentials are not configured",
    });
  }
  const res = await fetch("https://api.sendblue.co/api/send-group-message", {
    method: "POST",
    headers: {
      "sb-api-key-id": apiKey,
      "sb-api-secret-key": apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      group_id: groupId,
      from_number: fromNumber,
      content,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new VortexError({
      code: "AGENT_ERROR",
      status: 502,
      message: `Sendblue group send failed: ${res.status} ${body}`,
    });
  }
  return res.json();
}

export async function sendTyping(
  env: SmsWorkerEnv,
  toNumber: string
): Promise<void> {
  const apiKey = env.SENDBLUE_API_KEY;
  const apiSecret = env.SENDBLUE_API_SECRET;
  const fromNumber = env.SENDBLUE_FROM_NUMBER;
  if (!apiKey || !apiSecret || !fromNumber) return;
  await fetch("https://api.sendblue.co/api/typing", {
    method: "POST",
    headers: {
      "sb-api-key-id": apiKey,
      "sb-api-secret-key": apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: toNumber, from_number: fromNumber }),
  }).catch(() => {});
}

export async function addSmsContact(
  env: SmsWorkerEnv,
  number: string
): Promise<void> {
  const apiKey = env.SENDBLUE_API_KEY;
  const apiSecret = env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return;
  await fetch("https://api.sendblue.co/api/contacts", {
    method: "POST",
    headers: {
      "sb-api-key-id": apiKey,
      "sb-api-secret-key": apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number }),
  }).catch(() => {});
}

/** The workspace concierge prompt — the agent's entire world is the
 * workspace API. Refuse anything else. */
function smsAgentPrompt(input: {
  organizationId: string;
  orgName: string;
  phone: string;
  apiBase: string;
  apiKey: string;
  replyUrl: string;
}): string {
  return `You are the SMS concierge for the workspace "${input.orgName}" (${input.organizationId}).

A customer is texting from ${input.phone}. Everything they need lives in the workspace's API — issues, support tickets, CRM customers/contacts, documents, agent sessions.

## Your tools

- The Pile REST API at ${input.apiBase}
- Authorization: Bearer ${input.apiKey}
- Send your reply by POSTing to ${input.replyUrl} with JSON {"body": "<your sms reply>"}

## Rules — absolute

- You only act inside ${input.organizationId}. Refuse anything outside it.
- Every reply must go through the reply endpoint — the customer only sees what you POST there.
- Keep replies SMS-sized: plain text, short.
- If you can't answer from the API, say so and offer to file a ticket.
- For CRM ops (fill in store details, log a visit, update a contact), read first, write second — confirm what you changed in the reply.

## Workflow

1. Figure out what the customer needs (question vs. record update vs. bug report).
2. Call the API to read or write as needed.
3. POST your final reply.`;
}

async function mintAgentKey(
  env: SmsWorkerEnv,
  db: D1Client,
  organizationId: string,
  threadId: string
): Promise<{ keyId: string; key: string }> {
  const { createAuth } = await import("../platform/auth.js");
  const auth = await createAuth(env);
  // apikey rows FK to user — attribute the thread's key to the org's
  // first owner so revocation stays member-scoped, like tokens.ts does.
  const [owner] = await db
    .select({ userId: memberTable.userId })
    .from(memberTable)
    .where(
      and(
        eq(memberTable.organizationId, organizationId),
        eq(memberTable.role, "owner")
      )
    )
    .limit(1);
  if (!owner) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Workspace has no owner member to attribute sms keys to",
    });
  }
  const key = await auth.api.createApiKey({
    body: {
      userId: owner.userId,
      name: `sms:${threadId.slice(0, 8)}`,
      rateLimitEnabled: false,
      metadata: { organizationId, actorType: "agent" },
      permissions: {
        workspace: [
          "ticket:view",
          "ticket:create",
          "ticket:edit",
          "issue:view",
          "issue:create",
          "issue:edit",
          "comment:view",
          "comment:create",
          "comment:edit",
          "crm:view",
          "crm:edit",
          "contact:view",
          "contact:create",
          "contact:edit",
          "customer:view",
          "customer:create",
          "customer:edit",
          "document:view",
          "document:create",
          "document:edit",
        ],
      },
    } as never,
  });
  const parsed = key as { id: string; key: string } | undefined;
  if (!parsed?.key) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Failed to mint sms-agent key",
    });
  }
  return { keyId: parsed.id, key: parsed.key };
}

async function dispatchDevinSession(
  env: SmsWorkerEnv,
  input: { prompt: string; title: string }
): Promise<{ id: string; url: string | null }> {
  const orgId = env.DEVIN_ORG_ID;
  const token = env.DEVIN_TOKEN;
  if (!orgId || !token) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "Devin is not configured",
    });
  }
  const res = await fetch(
    `https://api.devin.ai/v3/organizations/${orgId}/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: input.prompt,
        bypass_approval: true,
        model: env.SMS_AGENT_MODEL ?? "swe-2",
        title: input.title,
        tags: ["sms-agent"],
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new VortexError({
      code: "AGENT_ERROR",
      status: 502,
      message: `Devin create failed: ${res.status} ${text}`,
    });
  }
  const body = (await res.json()) as {
    session_id?: string;
    id?: string;
    url?: string;
  };
  const id = body.session_id ?? body.id;
  if (!id) {
    throw new VortexError({
      code: "AGENT_ERROR",
      status: 502,
      message: "Devin response missing session id",
    });
  }
  return { id, url: body.url ?? null };
}

async function sendDevinMessage(
  env: SmsWorkerEnv,
  sessionId: string,
  prompt: string
) {
  const orgId = env.DEVIN_ORG_ID;
  const token = env.DEVIN_TOKEN;
  if (!orgId || !token) return;
  const devinId = sessionId.startsWith("devin-")
    ? sessionId
    : `devin-${sessionId}`;
  await fetch(
    `https://api.devin.ai/v3/organizations/${orgId}/sessions/${devinId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: prompt }),
    }
  ).catch(() => {});
}

/** Inbound sms → thread → ticket → message → agent dispatch. */
export async function handleInboundSms(
  db: D1Client,
  env: SmsWorkerEnv,
  input: {
    organizationId: string;
    fromNumber: string;
    body: string;
    groupId?: string | null;
    mediaUrl?: string | null;
  }
): Promise<{ threadId: string; ticketId: string }> {
  const phone = normalizePhone(input.fromNumber);
  const org = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, input.organizationId))
    .get();
  const customer = await findOrCreateCustomerByPhone(
    db,
    input.organizationId,
    phone
  );
  await addSmsContact(env, phone);
  let thread = await getSmsThread(
    db,
    input.organizationId,
    phone,
    input.groupId ?? null
  );
  const now = new Date().toISOString();

  if (!thread) {
    const ticket = await createTicket(db, {
      organizationId: input.organizationId,
      customerId: customer.id,
      title: input.groupId
        ? `SMS group — ${input.groupId.slice(0, 10)}`
        : `SMS — ${phone}`,
      sourceChannel: "sms",
      externalSource: "sms",
      externalId: input.groupId ? `sms-group:${input.groupId}` : `sms:${phone}`,
    });
    await addTicketMessage(db, input.organizationId, ticket.id, {
      direction: "inbound",
      textContent: input.body,
      channel: "sms",
      ...(input.mediaUrl ? { metadata: { mediaUrl: input.mediaUrl } } : {}),
    });
    const threadId = crypto.randomUUID();
    await db
      .insert(supportSmsThreads)
      .values({
        id: threadId,
        organizationId: input.organizationId,
        phone,
        groupId: input.groupId ?? null,
        customerId: customer.id,
        ticketId: ticket.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    thread = {
      id: threadId,
      organizationId: input.organizationId,
      phone,
      groupId: input.groupId ?? null,
      customerId: customer.id,
      ticketId: ticket.id,
      devinSessionId: null,
      apiKey: null,
      apiKeyId: null,
      createdAt: now,
      updatedAt: now,
    };
  } else {
    await addTicketMessage(db, input.organizationId, thread.ticketId!, {
      direction: "inbound",
      textContent: input.body,
      channel: "sms",
      ...(input.mediaUrl ? { metadata: { mediaUrl: input.mediaUrl } } : {}),
    });
  }

  const apiBase = (env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL ?? "").replace(
    /\/$/,
    ""
  );
  await sendTyping(env, thread.groupId ? `group:${thread.groupId}` : phone);
  if (thread.devinSessionId) {
    await sendDevinMessage(env, thread.devinSessionId, input.body);
  } else {
    const creds = await mintAgentKey(env, db, input.organizationId, thread.id);
    const replyUrl = `${apiBase}/workspaces/${input.organizationId}/support/sms/threads/${thread.id}/reply`;
    const session = await dispatchDevinSession(env, {
      title: `sms:${phone}`,
      prompt: smsAgentPrompt({
        organizationId: input.organizationId,
        orgName: org?.name ?? input.organizationId,
        phone,
        apiBase,
        apiKey: creds.key,
        replyUrl,
      }),
    });
    await db
      .update(supportSmsThreads)
      .set({
        devinSessionId: session.id,
        apiKey: creds.key,
        apiKeyId: creds.keyId,
        updatedAt: now,
      })
      .where(eq(supportSmsThreads.id, thread.id))
      .run();
    // The opening text lands as the first message on the fresh session.
    await sendDevinMessage(env, session.id, input.body);
  }

  return { threadId: thread.id, ticketId: thread.ticketId! };
}

/** The agent's reply → Sendblue outbound + the ticket's message log. */
export async function deliverSmsReply(
  db: D1Client,
  env: SmsWorkerEnv,
  input: { organizationId: string; threadId: string; body: string }
): Promise<{ message: SupportTicketEventWithDetails | null }> {
  const [thread] = await db
    .select()
    .from(supportSmsThreads)
    .where(
      and(
        eq(supportSmsThreads.id, input.threadId),
        eq(supportSmsThreads.organizationId, input.organizationId)
      )
    )
    .limit(1);
  if (!thread) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "SMS thread not found",
    });
  }
  if (thread.groupId) {
    await sendGroupSms(env, thread.groupId, input.body);
  } else {
    await sendSms(env, thread.phone, input.body);
  }
  const message = thread.ticketId
    ? await addTicketMessage(db, input.organizationId, thread.ticketId, {
        direction: "outbound",
        textContent: input.body,
        channel: "sms",
        actorType: "agent",
      })
    : null;
  return { message: message ?? null };
}

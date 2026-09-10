import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { sendIntercomMessage } from "../channels/intercom.js";
import { sendPlainMessage } from "../channels/plain.js";
import { sendSlackMessage } from "../channels/slack.js";
import { sendZendeskMessage } from "../channels/zendesk.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import { supportChannels, supportTicketEvents } from "./schema.js";
import {
  findOrCreateCustomerByEmail,
  getCustomerById,
} from "./support-contacts.js";
import { maybeEscalate } from "./support-escalation.js";
import {
  addTicketMessage,
  createTicket,
  findSupportTicketByExternalId,
  getTicketById,
  stripHtml,
  type SupportTicket,
  type SupportTicketMessageChannel,
  type SupportTicketSource,
} from "./support-tickets.js";
import { safeJSON } from "./team-metadata.js";

export type SupportChannel = typeof supportChannels.$inferSelect;

export const supportChannelConfigSchema = z
  .object({
    secretName: z.string().min(1).optional(),
  })
  .passthrough();

export type SupportChannelConfig = z.infer<typeof supportChannelConfigSchema>;

export function parseSupportChannelConfig(raw: string): SupportChannelConfig {
  const parsed = safeJSON(raw);
  const result = supportChannelConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid support channel config: ${result.error.message}`);
  }
  return result.data;
}

export async function getActiveSupportChannelByType(
  db: D1Client,
  organizationId: string,
  type: SupportChannel["type"]
): Promise<SupportChannel | null> {
  const [row] = await db
    .select()
    .from(supportChannels)
    .where(
      and(
        eq(supportChannels.organizationId, organizationId),
        eq(supportChannels.type, type),
        eq(supportChannels.isActive, true)
      )
    )
    .limit(1);
  return row ?? null;
}

export type ChannelIncomingMessage = {
  channel: SupportTicketMessageChannel;
  externalSource?: SupportTicketSource;
  fromEmail: string;
  fromName?: string | null;
  subject: string;
  text: string;
  html?: string | null;
  externalTicketId?: string | null;
  externalMessageId?: string | null;
  subType?: string | null;
  createdAt?: string;
};

export async function getActiveSupportChannel(
  db: D1Client,
  organizationId: string,
  type: SupportTicketMessageChannel,
  name: string
): Promise<SupportChannel | null> {
  const normalizedName = name.toLowerCase().trim();
  const [row] = await db
    .select()
    .from(supportChannels)
    .where(
      and(
        eq(supportChannels.organizationId, organizationId),
        eq(supportChannels.type, type),
        eq(supportChannels.name, normalizedName),
        eq(supportChannels.isActive, true)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function processIncomingMessage(
  db: D1Client,
  organizationId: string,
  input: ChannelIncomingMessage,
  env?: WorkerEnv
): Promise<SupportTicket> {
  const customer = await findOrCreateCustomerByEmail(
    db,
    organizationId,
    input.fromEmail,
    input.fromName,
    input.channel
  );

  const externalSource: SupportTicketSource = input.externalSource ?? "manual";
  let ticket: SupportTicket | null = null;
  if (input.externalTicketId) {
    ticket = await findSupportTicketByExternalId(
      db,
      organizationId,
      input.externalTicketId,
      externalSource
    );
  }

  const title =
    input.subject.trim() ||
    input.text.trim().slice(0, 120) ||
    `${input.channel} message`;

  if (!ticket) {
    ticket = await createTicket(
      db,
      {
        organizationId,
        customerId: customer.id,
        title,
        sourceChannel: input.channel,
        externalId: input.externalTicketId ?? null,
        externalSource,
        status: "todo",
        priority: "medium",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        ifExists: "return",
      },
      env
    );

    if (env) {
      await maybeEscalate(env, db, organizationId, ticket, {
        text: input.text,
        subject: input.subject,
        customer,
        source: externalSource,
        channel: input.channel,
      });
    }
  }

  const textContent =
    input.text.trim() ||
    (input.html ? stripHtml(input.html).trim() : "") ||
    input.subject.trim() ||
    `${input.channel} message`;

  await addTicketMessage(
    db,
    organizationId,
    ticket.id,
    {
      direction: "inbound",
      textContent,
      markdownContent: input.html,
      channel: input.channel,
      customerId: customer.id,
      subType: input.subType ?? null,
      externalId: input.externalMessageId ?? null,
      metadata:
        input.externalMessageId || input.subType
          ? {
              externalMessageId: input.externalMessageId,
              subType: input.subType,
            }
          : undefined,
      createdAt: input.createdAt,
    },
    env
  );

  return ticket;
}

export async function processOutgoingMessage(
  db: D1Client,
  env: WorkerEnv,
  channel: SupportChannel,
  input: {
    ticketId: string;
    textContent: string;
    markdownContent?: string | null;
    subject?: string | null;
    idempotencyKey?: string | null;
  },
  userId: string
): Promise<{ ok: true; messageId: string; sent: boolean }> {
  const ticket = await getTicketById(
    db,
    channel.organizationId,
    input.ticketId
  );
  if (!ticket) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Ticket not found",
    });
  }
  if (!ticket.customerId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Ticket has no customer",
    });
  }

  const customer = await getCustomerById(
    db,
    channel.organizationId,
    ticket.customerId
  );
  if (!customer) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Customer not found",
    });
  }

  const idempotencyKey = input.idempotencyKey ?? null;
  const metadata = idempotencyKey ? { idempotencyKey } : undefined;
  const event = await addTicketMessage(
    db,
    channel.organizationId,
    ticket.id,
    {
      direction: "outbound",
      textContent: input.textContent,
      markdownContent: input.markdownContent ?? null,
      channel: channel.type as SupportTicketMessageChannel,
      userId,
      actorType: "user",
      actorId: userId,
      subType: idempotencyKey ? "outbound" : null,
      externalId: idempotencyKey,
      metadata,
    },
    env
  );

  const channelConfig: Record<string, unknown> = JSON.parse(channel.config);

  let sent = false;
  if (event.isNew) {
    if (channel.type === "email" && env.EMAIL) {
      try {
        await env.EMAIL.send({
          from: channel.name,
          to: customer.email,
          subject: input.subject ?? ticket.title,
          text: input.textContent,
          html: input.markdownContent ?? undefined,
        });
        sent = true;
      } catch {
        sent = false;
      }
    }

    if (
      channel.type === "slack" &&
      typeof channelConfig.botToken === "string" &&
      typeof channelConfig.channelId === "string"
    ) {
      sent = await sendSlackMessage({
        botToken: channelConfig.botToken,
        channelId: channelConfig.channelId,
        text: input.textContent,
      });
    }

    if (
      channel.type === "intercom" &&
      typeof channelConfig.accessToken === "string" &&
      typeof channelConfig.adminId === "string" &&
      ticket.externalId
    ) {
      sent = await sendIntercomMessage({
        accessToken: channelConfig.accessToken,
        adminId: channelConfig.adminId,
        conversationId: ticket.externalId,
        text: input.textContent,
      });
    }

    if (
      channel.type === "zendesk" &&
      typeof channelConfig.subdomain === "string" &&
      typeof channelConfig.accessToken === "string" &&
      typeof channelConfig.email === "string" &&
      ticket.externalId
    ) {
      sent = await sendZendeskMessage({
        subdomain: channelConfig.subdomain,
        accessToken: channelConfig.accessToken,
        email: channelConfig.email,
        ticketId: ticket.externalId,
        text: input.textContent,
      });
    }

    if (
      channel.type === "plain" &&
      typeof channelConfig.accessToken === "string" &&
      ticket.externalId
    ) {
      sent = await sendPlainMessage({
        accessToken: channelConfig.accessToken,
        threadId: ticket.externalId,
        textContent: input.textContent,
        markdownContent: input.markdownContent ?? null,
      });
    }

    if (idempotencyKey) {
      await db
        .update(supportTicketEvents)
        .set({
          metadata: JSON.stringify({ idempotencyKey, sent }),
        })
        .where(eq(supportTicketEvents.id, event.id));
    }
  } else if (idempotencyKey && event.metadata) {
    const parsed = JSON.parse(event.metadata) as Record<string, unknown>;
    sent = parsed.sent === true;
  }

  return { ok: true, messageId: event.id, sent };
}

type ValidateChannelResult = {
  ok: boolean;
  message?: string;
};

export async function validateSupportChannel(
  db: D1Client,
  env: WorkerEnv,
  channel: SupportChannel
): Promise<ValidateChannelResult> {
  void db;

  const channelConfig: Record<string, unknown> = JSON.parse(channel.config);

  if (channel.type === "email") {
    if (!env.EMAIL) {
      return { ok: false, message: "Email binding not configured" };
    }
    if (!channel.name.includes("@")) {
      return {
        ok: false,
        message: "Channel name is not a valid email address",
      };
    }
    return { ok: true };
  }

  if (channel.type === "slack" && typeof channelConfig.botToken === "string") {
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        headers: {
          Authorization: `Bearer ${channelConfig.botToken}`,
        },
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          message: data.error ?? "Slack auth.test failed",
        };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "Network error" };
    }
  }

  if (
    channel.type === "intercom" &&
    typeof channelConfig.accessToken === "string"
  ) {
    try {
      const res = await fetch("https://api.intercom.io/me", {
        headers: {
          Authorization: `Bearer ${channelConfig.accessToken}`,
          Accept: "application/json",
        },
      });
      const data = (await res.json()) as { type?: string } | undefined;
      if (!res.ok || data?.type !== "admin") {
        return { ok: false, message: "Intercom token invalid" };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "Network error" };
    }
  }

  if (
    channel.type === "zendesk" &&
    typeof channelConfig.subdomain === "string" &&
    typeof channelConfig.accessToken === "string" &&
    typeof channelConfig.email === "string"
  ) {
    try {
      const auth = btoa(
        `${channelConfig.email}/token:${channelConfig.accessToken}`
      );
      const res = await fetch(
        `https://${channelConfig.subdomain}.zendesk.com/api/v2/users/me.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      if (!res.ok) {
        return { ok: false, message: "Zendesk credentials invalid" };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "Network error" };
    }
  }

  if (
    channel.type === "plain" &&
    typeof channelConfig.accessToken === "string"
  ) {
    try {
      const res = await fetch("https://api.plain.com/v1/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channelConfig.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "query { workspace { id } }",
        }),
      });
      const data = (await res.json()) as {
        data?: { workspace?: { id: string } };
      };
      if (!res.ok || !data.data?.workspace?.id) {
        return { ok: false, message: "Plain workspace not reachable" };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "Network error" };
    }
  }

  return {
    ok: true,
    message: "No remote validation configured for this channel type",
  };
}

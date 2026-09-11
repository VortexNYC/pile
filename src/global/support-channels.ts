import { and, eq } from "drizzle-orm";

import { sendSlackMessage } from "../channels/slack.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import { supportChannels } from "./schema.js";
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
  type SupportTicket,
  type SupportTicketMessageChannel,
  type SupportTicketSource,
} from "./support-tickets.js";

export type SupportChannel = typeof supportChannels.$inferSelect;

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

  await addTicketMessage(
    db,
    organizationId,
    ticket.id,
    {
      direction: "inbound",
      textContent: input.text,
      markdownContent: input.html,
      channel: input.channel,
      customerId: customer.id,
      subType: input.externalMessageId ?? null,
      metadata: input.externalMessageId
        ? { externalMessageId: input.externalMessageId }
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
    },
    env
  );

  const channelConfig: Record<string, unknown> = JSON.parse(channel.config);

  let sent = false;
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

  return { ok: true, messageId: event.id, sent };
}

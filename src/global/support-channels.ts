import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { supportChannels } from "./schema.js";
import { findOrCreateCustomerByEmail } from "./support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  findSupportTicketByExternalId,
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
  input: ChannelIncomingMessage
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
    ticket = await createTicket(db, {
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
    });
  }

  await addTicketMessage(db, organizationId, ticket.id, {
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
  });

  return ticket;
}

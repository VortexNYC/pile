import { and, eq } from "drizzle-orm";
import PostalMime from "postal-mime";

import { createD1, type D1Client } from "../global/db.js";
import { supportChannels } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import type { WorkerEnv } from "../platform/middleware.js";

export interface IncomingEmailMessage {
  from: string;
  to: string | { address?: string; name?: string }[];
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

function isAddressLike(
  value: unknown
): value is { address: unknown; name?: unknown } {
  return typeof value === "object" && value !== null && "address" in value;
}

function extractReferenceMessageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/<([^>]+)>/);
  return match ? match[1] : value.trim() || null;
}

function addressObject(value: unknown): {
  address: string;
  name: string | null;
} {
  if (typeof value === "string") {
    return { address: value.trim().toLowerCase(), name: null };
  }
  if (isAddressLike(value) && typeof value.address === "string") {
    return {
      address: value.address.trim().toLowerCase(),
      name: typeof value.name === "string" ? value.name : null,
    };
  }
  return { address: "", name: null };
}

function firstAddress(
  value: string | { address?: string; name?: string }[] | undefined
): { address: string; name: string | null } {
  if (typeof value === "string") {
    return { address: value.trim().toLowerCase(), name: null };
  }
  if (Array.isArray(value) && value.length > 0) {
    const item = value[0];
    if (item && typeof item.address === "string") {
      return {
        address: item.address.trim().toLowerCase(),
        name: typeof item.name === "string" ? item.name : null,
      };
    }
  }
  return { address: "", name: null };
}

async function readRawEmail(
  raw: ReadableStream<Uint8Array>
): Promise<ArrayBuffer> {
  const response = new Response(raw);
  return response.arrayBuffer();
}

async function findChannelByEmailAddress(
  db: D1Client,
  address: string
): Promise<{ organizationId: string } | null> {
  const normalized = address.toLowerCase().trim();
  const [match] = await db
    .select()
    .from(supportChannels)
    .where(
      and(
        eq(supportChannels.type, "email"),
        eq(supportChannels.isActive, true),
        eq(supportChannels.name, normalized)
      )
    )
    .limit(1);
  return match ? { organizationId: match.organizationId } : null;
}

export async function handleIncomingEmail(
  message: IncomingEmailMessage,
  env: WorkerEnv
): Promise<void> {
  const to = firstAddress(message.to);
  if (!to.address) {
    message.setReject("Missing recipient");
    return;
  }

  const db = createD1(env.D1);
  const channel = await findChannelByEmailAddress(db, to.address);
  if (!channel) {
    message.setReject("No active support channel for recipient");
    return;
  }

  const raw = await readRawEmail(message.raw);
  const parsed = await PostalMime.parse(raw);

  const fromHeader = addressObject(parsed.from);
  const fromEnvelope = firstAddress(message.from);
  const from = {
    address: fromEnvelope.address || fromHeader.address,
    name: fromHeader.name ?? fromEnvelope.name,
  };
  if (!from.address) {
    message.setReject("Missing sender");
    return;
  }

  const text = typeof parsed.text === "string" ? parsed.text : "";
  const html = typeof parsed.html === "string" ? parsed.html : null;
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const messageId =
    typeof parsed.messageId === "string" ? parsed.messageId : null;
  const inReplyTo =
    typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null;
  const messageIdValue = extractReferenceMessageId(messageId);
  const inReplyToValue = extractReferenceMessageId(inReplyTo);
  const externalTicketId = inReplyToValue ?? messageIdValue;

  await processIncomingMessage(db, channel.organizationId, {
    channel: "email",
    externalSource: "email",
    fromEmail: from.address,
    fromName: from.name,
    subject,
    text,
    html,
    externalTicketId,
    externalMessageId: messageIdValue,
  });
}

import { and, asc, eq } from "drizzle-orm";
import PostalMime, { type Attachment } from "postal-mime";
import { z } from "zod";

import { createD1, type D1Client } from "../global/db.js";
import { emailInboxes, supportChannels } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import {
  enqueueWebhook,
  scopedDeliveryId,
  type WebhookProcessor,
  type WebhookSource,
} from "../global/webhook-queue.js";
import type { WorkerEnv } from "../platform/middleware.js";

export interface IncomingEmailMessage {
  from: string;
  to: string | { address?: string; name?: string }[];
  raw: ForwardableEmailMessage["raw"];
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

async function findInboxByEmailAddress(
  db: D1Client,
  address: string
): Promise<typeof emailInboxes.$inferSelect | null> {
  const normalized = address.toLowerCase().trim();
  // Addresses aren't globally unique (same as support_channels); oldest row
  // wins so a duplicate registration can't silently reroute mail.
  const [match] = await db
    .select()
    .from(emailInboxes)
    .where(
      and(eq(emailInboxes.address, normalized), eq(emailInboxes.enabled, true))
    )
    .orderBy(asc(emailInboxes.createdAt))
    .limit(1);
  return match ?? null;
}

const emailQueuePayloadSchema = z.object({
  organizationId: z.string(),
  to: z.string(),
  from: z.string(),
  fromName: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  html: z.string().nullable(),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
});

export async function processEmailWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
) {
  const data = emailQueuePayloadSchema.parse(payload);
  return processIncomingMessage(
    db,
    data.organizationId,
    {
      channel: "email",
      externalSource: "email",
      fromEmail: data.from,
      fromName: data.fromName,
      subject: data.subject,
      text: data.text,
      html: data.html,
      externalTicketId: data.inReplyTo ?? data.messageId,
      externalMessageId: data.messageId,
      subType: "email",
    },
    env
  );
}

const emailIntakeAttachmentSchema = z.object({
  key: z.string().nullable(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

const emailIntakePayloadSchema = z.object({
  organizationId: z.string(),
  inboxId: z.string().nullable(),
  customerId: z.string().nullable(),
  to: z.string(),
  from: z.string(),
  fromName: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  html: z.string().nullable(),
  messageId: z.string().nullable(),
  externalId: z.string(),
  receivedAt: z.string(),
  attachments: z.array(emailIntakeAttachmentSchema).default([]),
});

// Files an inbound intake email on the matched (or newly created) workspace
// customer. Idempotent on `externalId` (the Message-ID / raw-MIME hash) via
// the customer_intake_items unique index, so queue retries can't double-file.
export async function processEmailIntakePayload(
  _db: D1Client,
  env: WorkerEnv,
  payload: unknown
) {
  const data = emailIntakePayloadSchema.parse(payload);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(data.organizationId)
  );
  await stub.setOrganizationId(data.organizationId);

  let customerId = data.customerId
    ? ((await stub.getCustomer(data.customerId))?.id ?? null)
    : null;
  let customerCreated = false;
  if (!customerId) {
    const resolved = await stub.resolveCustomerForEmail({
      email: data.from,
      name: data.fromName,
    });
    customerId = resolved.customer.id;
    customerCreated = resolved.created;
  }

  const { item, isNew } = await stub.fileCustomerIntakeItem({
    customerId,
    inboxId: data.inboxId,
    fromAddress: data.from,
    fromName: data.fromName,
    toAddress: data.to,
    subject: data.subject,
    text: data.text,
    html: data.html,
    externalId: data.externalId,
    messageId: data.messageId,
    attachments: data.attachments,
    receivedAt: data.receivedAt,
  });

  return {
    customerId,
    customerCreated,
    intakeItemId: item?.id ?? null,
    isNew,
  };
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function attachmentBytes(
  content: ArrayBuffer | Uint8Array | string
): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function sanitizeFilename(filename: string | null): string {
  const stripped = (filename ?? "")
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  const cleaned = stripped.replace(/[/\\]/g, "_").trim();
  return cleaned || "attachment";
}

// Stores parsed MIME parts in R2 so the queued payload stays small. Keys are
// deterministic per externalId+position, so a redelivered message overwrites
// the same objects instead of piling up orphans.
async function storeIntakeAttachments(
  env: WorkerEnv,
  organizationId: string,
  storageKey: string,
  attachments: Attachment[]
): Promise<z.infer<typeof emailIntakeAttachmentSchema>[]> {
  const bucket = env.ATTACHMENTS_BUCKET;
  return Promise.all(
    attachments.map(async (attachment, index) => {
      const bytes = attachmentBytes(attachment.content);
      const filename = sanitizeFilename(attachment.filename);
      const contentType = attachment.mimeType || "application/octet-stream";
      let key: string | null = null;
      if (bucket && bytes.byteLength > 0) {
        key = `${organizationId}/intake/${storageKey}/${index}-${filename}`;
        try {
          await bucket.put(key, bytes, { httpMetadata: { contentType } });
        } catch (error) {
          console.error("intake attachment upload failed", {
            organizationId,
            filename,
            error: error instanceof Error ? error.message : String(error),
          });
          key = null;
        }
      }
      return { key, filename, contentType, size: bytes.byteLength };
    })
  );
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
  // Support-channel addresses keep the ticket flow; an address registered as
  // a customer intake inbox routes to the intake flow instead (PILE-325).
  const inbox = channel ? null : await findInboxByEmailAddress(db, to.address);
  if (!channel && !inbox) {
    message.setReject("No active destination for recipient");
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

  const processors = new Map<WebhookSource, WebhookProcessor>([
    ["email", processEmailWebhookPayload],
    ["email-intake", processEmailIntakePayload],
  ]);

  if (channel) {
    if (!messageIdValue) {
      message.setReject("Missing Message-ID header");
      return;
    }

    await enqueueWebhook(
      db,
      env,
      {
        deliveryId: scopedDeliveryId(
          "email",
          channel.organizationId,
          messageIdValue
        ),
        source: "email",
        event: "received",
        organizationId: channel.organizationId,
        payload: {
          organizationId: channel.organizationId,
          to: to.address,
          from: from.address,
          fromName: from.name,
          subject,
          text,
          html,
          messageId: messageIdValue,
          inReplyTo: inReplyToValue,
        },
      },
      processors
    );
    return;
  }

  if (!inbox) {
    message.setReject("No active destination for recipient");
    return;
  }

  // Senders sometimes omit Message-ID; hash the raw MIME so dedup still works.
  const externalId = messageIdValue ?? `sha256:${await sha256Hex(raw)}`;
  const storageKey = await sha256Hex(new TextEncoder().encode(externalId));
  const attachments = await storeIntakeAttachments(
    env,
    inbox.organizationId,
    storageKey,
    parsed.attachments
  );

  const parsedDate =
    typeof parsed.date === "string" ? new Date(parsed.date) : null;
  const receivedAt =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : new Date().toISOString();

  await enqueueWebhook(
    db,
    env,
    {
      deliveryId: scopedDeliveryId(
        "email-intake",
        inbox.organizationId,
        externalId
      ),
      source: "email-intake",
      event: "received",
      organizationId: inbox.organizationId,
      payload: {
        organizationId: inbox.organizationId,
        inboxId: inbox.id,
        customerId: inbox.customerId,
        to: to.address,
        from: from.address,
        fromName: from.name,
        subject,
        text,
        html,
        messageId: messageIdValue,
        externalId,
        receivedAt,
        attachments,
      },
    },
    processors
  );
}

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  supportChannels,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { handleIncomingEmail, type IncomingEmailMessage } from "./email.js";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

let organizationId: string;

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Email test workspace",
    slug: `email-test-${crypto.randomUUID()}`,
    key: `E${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  const id = workspace!.id;
  const channelNow = new Date();
  await db.insert(supportChannels).values({
    id: crypto.randomUUID(),
    organizationId: id,
    type: "email",
    name: "support@example.com",
    isActive: true,
    config: "{}",
    createdAt: channelNow.toISOString(),
    updatedAt: channelNow.toISOString(),
  });
  return id;
}

function makeEmailMessage(
  envelopeTo: string,
  envelopeFrom: string,
  body: string,
  overrides: { subject?: string; messageId?: string; inReplyTo?: string } = {}
): IncomingEmailMessage & { get rejectedReason(): string } {
  const mime = [
    `From: ${envelopeFrom}`,
    `To: ${envelopeTo}`,
    `Subject: ${overrides.subject ?? "Need help"}`,
    overrides.messageId ? `Message-ID: ${overrides.messageId}` : "",
    overrides.inReplyTo ? `In-Reply-To: ${overrides.inReplyTo}` : "",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
  const bytes = new Uint8Array(new TextEncoder().encode(mime));
  let rejectedReason = "";
  return {
    from: envelopeFrom,
    to: envelopeTo,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    get rejectedReason() {
      return rejectedReason;
    },
    setReject(reason: string) {
      rejectedReason = reason;
    },
  };
}

describe("incoming email handler", () => {
  beforeAll(async () => {
    organizationId = await seedWorkspace();
  });

  it("creates a support ticket from a valid inbound email", async () => {
    const message = makeEmailMessage(
      "support@example.com",
      "user@example.com",
      "I cannot log in.",
      { messageId: "<msg-1@example.com>" }
    );
    await handleIncomingEmail(message, env);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, "msg-1@example.com"))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("Need help");
    expect(ticket?.sourceChannel).toBe("email");
    expect(ticket?.organizationId).toBe(organizationId);
  });

  it("adds a reply to an existing ticket using In-Reply-To", async () => {
    const reply = makeEmailMessage(
      "support@example.com",
      "user@example.com",
      "Still broken.",
      {
        messageId: "<msg-2@example.com>",
        subject: "Re: Need help",
        inReplyTo: "<msg-1@example.com>",
      }
    );
    await handleIncomingEmail(reply, env);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, "msg-1@example.com"))
      .get();
    expect(ticket).toBeDefined();
  });

  it("rejects email with no recipient", async () => {
    const message = makeEmailMessage("", "user@example.com", "body");
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("Missing recipient");
  });

  it("rejects email for an unknown support channel", async () => {
    const message = makeEmailMessage(
      "unknown@example.com",
      "user@example.com",
      "body"
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe(
      "No active support channel for recipient"
    );
  });

  it("rejects email with no sender", async () => {
    const message = makeEmailMessage("support@example.com", "", "body");
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("Missing sender");
  });

  it("rejects email with no Message-ID header", async () => {
    const message = makeEmailMessage(
      "support@example.com",
      "user@example.com",
      "body"
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("Missing Message-ID header");
  });
});

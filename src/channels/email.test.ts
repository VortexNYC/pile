import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  emailInboxes,
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
  overrides: {
    subject?: string;
    messageId?: string;
    inReplyTo?: string;
    rawMime?: string;
  } = {}
): IncomingEmailMessage & { get rejectedReason(): string } {
  const mime =
    overrides.rawMime ??
    [
      ...[
        `From: ${envelopeFrom}`,
        `To: ${envelopeTo}`,
        `Subject: ${overrides.subject ?? "Need help"}`,
        overrides.messageId ? `Message-ID: ${overrides.messageId}` : "",
        overrides.inReplyTo ? `In-Reply-To: ${overrides.inReplyTo}` : "",
      ].filter(Boolean),
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n");
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
    expect(message.rejectedReason).toBe("No active destination for recipient");
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

describe("customer email intake", () => {
  let intakeOrgId: string;
  let pinnedInboxId: string;
  let pinnedCustomerId: string;

  function intakeStub() {
    return env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(intakeOrgId)
    );
  }

  beforeAll(async () => {
    intakeOrgId = await seedWorkspace();
    const db = createD1(env.D1);
    const now = new Date().toISOString();
    await db.insert(emailInboxes).values({
      id: crypto.randomUUID(),
      organizationId: intakeOrgId,
      address: "intake@example.com",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const stub = intakeStub();
    await stub.setOrganizationId(intakeOrgId);
    const pinned = await stub.createCustomer({
      name: "Pinned Co",
      url: "https://pinned.example",
    });
    pinnedCustomerId = pinned.id;
    pinnedInboxId = crypto.randomUUID();
    await db.insert(emailInboxes).values({
      id: pinnedInboxId,
      organizationId: intakeOrgId,
      address: "pinned@example.com",
      customerId: pinnedCustomerId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("files inbound mail on a customer created from the sender domain", async () => {
    const message = makeEmailMessage(
      "intake@example.com",
      "rep@acme.com",
      "Attached is our W-9.",
      { subject: "W-9 form", messageId: "<intake-1@acme.com>" }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    const acme = customers.find((c) => c.url === "https://acme.com");
    expect(acme).toBeDefined();
    expect(acme?.name).toBe("acme.com");

    const items = await stub.listCustomerIntakeItems(acme!.id);
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe("W-9 form");
    expect(items[0].fromAddress).toBe("rep@acme.com");
    expect(items[0].toAddress).toBe("intake@example.com");
    expect(items[0].externalId).toBe("intake-1@acme.com");
    expect(items[0].text).toContain("W-9");

    // Intake mail must not also open a support ticket.
    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, "intake-1@acme.com"))
      .get();
    expect(ticket).toBeUndefined();
  });

  it("routes follow-up mail from the same domain onto the same customer", async () => {
    const message = makeEmailMessage(
      "intake@example.com",
      "billing@acme.com",
      "Signed agreement attached.",
      { subject: "Signed agreement", messageId: "<intake-2@acme.com>" }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    expect(customers.filter((c) => c.url === "https://acme.com")).toHaveLength(
      1
    );
    expect(
      customers.filter((c) => c.url === "https://billing.acme.com")
    ).toHaveLength(0);
    const acme = customers.find((c) => c.url === "https://acme.com");
    const items = await stub.listCustomerIntakeItems(acme!.id);
    expect(items).toHaveLength(2);
  });

  it("does not double-file a redelivered message", async () => {
    const message = makeEmailMessage(
      "intake@example.com",
      "billing@acme.com",
      "Signed agreement attached.",
      { subject: "Signed agreement", messageId: "<intake-2@acme.com>" }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    const acme = customers.find((c) => c.url === "https://acme.com");
    const items = await stub.listCustomerIntakeItems(acme!.id);
    expect(items).toHaveLength(2);
  });

  it("files on the pinned customer when the inbox has customerId", async () => {
    const message = makeEmailMessage(
      "pinned@example.com",
      "random@unrelated.example",
      "Documents for the pinned record.",
      { subject: "Pinned docs", messageId: "<pinned-1@unrelated.example>" }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const items = await stub.listCustomerIntakeItems(pinnedCustomerId);
    expect(items).toHaveLength(1);
    expect(items[0].inboxId).toBe(pinnedInboxId);
    expect(items[0].subject).toBe("Pinned docs");

    const customers = await stub.listCustomers();
    expect(customers.some((c) => c.name === "unrelated.example")).toBe(false);
  });

  it("stores attachments in R2 and records them on the item", async () => {
    const mime = [
      "From: rep@acme.com",
      "To: intake@example.com",
      "Subject: Contract PDF",
      "Message-ID: <intake-att@acme.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="MIX"',
      "",
      "--MIX",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      "",
      "--MIX",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="contract.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "QUJD",
      "",
      "--MIX--",
      "",
    ].join("\r\n");
    const message = makeEmailMessage("intake@example.com", "rep@acme.com", "", {
      rawMime: mime,
    });
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    const acme = customers.find((c) => c.url === "https://acme.com");
    const items = await stub.listCustomerIntakeItems(acme!.id);
    const item = items.find((i) => i.subject === "Contract PDF");
    expect(item).toBeDefined();

    const attachments = JSON.parse(item!.attachments ?? "[]") as {
      key: string | null;
      filename: string;
      contentType: string;
      size: number;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("contract.pdf");
    expect(attachments[0].contentType).toBe("application/pdf");
    expect(attachments[0].size).toBe(3);
    expect(attachments[0].key).toMatch(
      new RegExp(`^${intakeOrgId}/intake/[^/]+/0-contract\\.pdf$`)
    );

    const object = await env.ATTACHMENTS_BUCKET.get(attachments[0].key!);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe("ABC");
  });

  it("files mail without a Message-ID using a raw-MIME hash", async () => {
    const message = makeEmailMessage(
      "intake@example.com",
      "ops@acme.com",
      "No message id on this one.",
      { subject: "No message id" }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    const acme = customers.find((c) => c.url === "https://acme.com");
    const items = await stub.listCustomerIntakeItems(acme!.id);
    const item = items.find((i) => i.subject === "No message id");
    expect(item).toBeDefined();
    expect(item!.externalId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(item!.messageId).toBeNull();
  });

  it("names freemail senders by display name instead of domain", async () => {
    const mime = [
      "From: Jane Rep <jane.rep@gmail.com>",
      "To: intake@example.com",
      "Subject: Freemail docs",
      "Message-ID: <freemail-1@gmail.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Docs from a gmail rep.",
      "",
    ].join("\r\n");
    const message = makeEmailMessage(
      "intake@example.com",
      "jane.rep@gmail.com",
      "",
      { rawMime: mime }
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("");

    const stub = intakeStub();
    const customers = await stub.listCustomers();
    const jane = customers.find((c) => c.name === "Jane Rep");
    expect(jane).toBeDefined();
    expect(jane?.url).toBeNull();
    expect(customers.some((c) => c.name === "gmail.com")).toBe(false);
    const items = await stub.listCustomerIntakeItems(jane!.id);
    expect(items).toHaveLength(1);
  });

  it("ignores disabled inboxes", async () => {
    const db = createD1(env.D1);
    const now = new Date().toISOString();
    await db.insert(emailInboxes).values({
      id: crypto.randomUUID(),
      organizationId: intakeOrgId,
      address: "disabled@example.com",
      enabled: false,
      createdAt: now,
      updatedAt: now,
    });
    const message = makeEmailMessage(
      "disabled@example.com",
      "rep@acme.com",
      "body"
    );
    await handleIncomingEmail(message, env);
    expect(message.rejectedReason).toBe("No active destination for recipient");
  });
});

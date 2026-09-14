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
import { processSlackSupportWebhookPayload } from "./slack.js";

let organizationId: string;

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-slack-1",
      name: "Slack Test User",
      email: "slack-test@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "user-slack-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Slack channel test workspace",
    slug: `slack-channel-test-${crypto.randomUUID()}`,
    key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-slack-1",
  });
  return workspace.id;
}

function makeSlackQueuePayload(input: {
  organizationId: string;
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  email: string;
  name?: string;
}) {
  return {
    notification: {
      type: "event_callback",
      event: {
        type: "message",
        channel: input.channel,
        user: "U123",
        text: input.text,
        ts: input.ts,
        thread_ts: input.threadTs,
        user_profile: { email: input.email, name: input.name ?? "Customer" },
      },
    },
    organizationId: input.organizationId,
  };
}

async function createSlackChannel(
  config: Record<string, string>,
  name: string
) {
  const db = createD1(env.D1);
  const channelNow = new Date().toISOString();
  const normalizedName = name.toLowerCase().trim();
  await db.insert(supportChannels).values({
    id: crypto.randomUUID(),
    organizationId,
    type: "slack",
    name: normalizedName,
    isActive: true,
    config: JSON.stringify(config),
    createdAt: channelNow,
    updatedAt: channelNow,
  });
  return normalizedName;
}

let tsCounter = 0;

function makeTs(): string {
  tsCounter += 1;
  return `1700000000.${String(tsCounter).padStart(6, "0")}`;
}

describe("processSlackSupportWebhookPayload", () => {
  beforeAll(async () => {
    organizationId = await seedWorkspace();
  });

  it("creates a support ticket in one_to_one mode", async () => {
    const channel = await createSlackChannel(
      { ingestionMode: "one_to_one" },
      "C123"
    );
    const ts = makeTs();
    const payload = makeSlackQueuePayload({
      organizationId,
      channel,
      ts,
      text: "I need help with my account.",
      email: "customer-1@example.com",
    });
    const db = createD1(env.D1);
    await processSlackSupportWebhookPayload(db, env, payload);

    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, ts))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("I need help with my account.");
    expect(ticket?.sourceChannel).toBe("slack");
  });

  it("does not create a support ticket in manual mode", async () => {
    const channel = await createSlackChannel(
      { ingestionMode: "manual" },
      "C124"
    );
    const ts = makeTs();
    const payload = makeSlackQueuePayload({
      organizationId,
      channel,
      ts,
      text: "This should not create a ticket.",
      email: "customer-2@example.com",
    });
    const db = createD1(env.D1);
    await processSlackSupportWebhookPayload(db, env, payload);

    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, ts))
      .get();
    expect(ticket).toBeUndefined();
  });

  it("does not create a support ticket for time_based mode", async () => {
    const channel = await createSlackChannel(
      { ingestionMode: "time_based" },
      "C125"
    );
    const ts = makeTs();
    const payload = makeSlackQueuePayload({
      organizationId,
      channel,
      ts,
      text: "This is a time-based message.",
      email: "customer-3@example.com",
    });
    const db = createD1(env.D1);
    await processSlackSupportWebhookPayload(db, env, payload);

    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, ts))
      .get();
    expect(ticket).toBeUndefined();
  });

  it("falls back to one_to_one when ingestionMode is missing", async () => {
    const channel = await createSlackChannel({ botToken: "xoxb-123" }, "C126");
    const ts = makeTs();
    const payload = makeSlackQueuePayload({
      organizationId,
      channel,
      ts,
      text: "Default mode creates a ticket.",
      email: "customer-4@example.com",
    });
    const db = createD1(env.D1);
    await processSlackSupportWebhookPayload(db, env, payload);

    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, ts))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("Default mode creates a ticket.");
  });
});

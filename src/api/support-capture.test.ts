import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import { supportCustomers, user as userTable } from "../global/schema.js";
import {
  supportCaptureSessions,
  supportTicketAttachments,
  supportTicketEvents,
} from "../global/schema.js";
import {
  createCapturePublicKey,
  createCaptureSession,
  expireStaleCaptureSessions,
} from "../global/support-capture.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
import { createTicket, getTicketById } from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-capture",
      name: "Capture User",
      email: "capture-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-capture");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support capture test",
    slug: `support-capture-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-capture",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-capture",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function captureFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://example.com${path}`, init);
  return app.fetch(request, env) as Promise<Response>;
}

async function signJamWebhook({
  payload,
  svixId,
  svixTimestamp,
  secret,
}: {
  payload: string;
  svixId: string;
  svixTimestamp: string;
  secret: string;
}): Promise<string> {
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = new Uint8Array(
    atob(rawSecret)
      .split("")
      .map((c) => c.charCodeAt(0))
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = `${svixId}.${svixTimestamp}.${payload}`;
  const signedBytes = new TextEncoder().encode(signed);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, signedBytes)
  );
  const binary = Array.from(expected)
    .map((b) => String.fromCharCode(b))
    .join("");
  return `v1,${btoa(binary)}`;
}

describe("support-capture API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  async function createPublicKey(): Promise<{
    id: string;
    key: string;
    webhookSecret: string;
  }> {
    const res = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "Website widget",
          allowedOrigins: ["https://example.com"],
        }),
      }
    );
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      key: string;
      webhookSecret: string;
    };
  }

  async function issueCaptureToken(
    publicKey: { key: string },
    origin = "https://example.com",
    reference?: string
  ): Promise<{ token: string; recordingUrl: string }> {
    const res = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        ...(reference ? { "x-vortex-capture-reference": reference } : {}),
        origin,
      },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { token: string; recordingUrl: string };
  }

  it("rejects public key creation without auth", async () => {
    const res = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No auth", allowedOrigins: [] }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects token for an unknown public key", async () => {
    const res = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": "vtx_00000000000000000000000000000000",
        origin: "https://example.com",
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects token for a revoked public key", async () => {
    const publicKey = await createPublicKey();

    const revokeRes = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys/${publicKey.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect(revokeRes.status).toBe(200);

    const tokenRes = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        origin: "https://example.com",
      },
    });
    expect(tokenRes.status).toBe(401);
  });

  it("returns a public recording URL with the capture token", async () => {
    const publicKey = await createPublicKey();
    const { token: sessionToken, recordingUrl } =
      await issueCaptureToken(publicKey);
    expect(recordingUrl).toContain(`/support/capture/sessions/${sessionToken}`);

    const sessionRes = await captureFetch(new URL(recordingUrl).pathname);
    expect(sessionRes.status).toBe(200);
    const body = (await sessionRes.json()) as {
      sessionId: string;
      status: string;
      uploads: unknown[];
    };
    expect(body.sessionId).toBe(sessionToken);
    expect(body.status).toBe("pending");
    expect(body.uploads).toEqual([]);
  });

  it("rejects upload-session without a token", async () => {
    const res = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No token" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects upload for an unknown session", async () => {
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const res = await captureFetch(
      "/support/capture/upload/00000000-0000-0000-0000-000000000000/screenshot",
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "x-vortex-capture-token": "00000000-0000-0000-0000-000000000000",
        },
        body: image,
      }
    );
    expect(res.status).toBe(401);
  });

  it("rejects finalize when email is missing", async () => {
    const publicKey = await createPublicKey();
    const { token: sessionToken } = await issueCaptureToken(publicKey);

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "No email",
        metadata: {},
      }),
    });
    expect(sessionRes.status).toBe(200);

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(400);
  });

  it("creates a capture public key and captures through to a ticket", async () => {
    const publicKey = await createPublicKey();

    const listRes = await captureFetch(
      `/workspaces/${organizationId}/support/capture/public-keys`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { publicKeys: { key: string }[] };
    expect(list.publicKeys.some((k) => k.key === publicKey.key)).toBe(true);

    const badOriginRes = await captureFetch("/support/capture/token", {
      method: "POST",
      headers: {
        "x-vortex-capture-public-key": publicKey.key,
        origin: "https://evil.com",
      },
    });
    expect(badOriginRes.status).toBe(401);

    const { token: sessionToken } = await issueCaptureToken(publicKey);

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "Button is broken",
        description: "Clicking the submit button does nothing",
        priority: "high",
        metadata: {
          email: "reporter@example.com",
          contentType: "image/png",
        },
      }),
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      uploadUrl: string;
      sessionId: string;
    };

    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploadRes = await captureFetch(session.uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "x-vortex-capture-token": sessionToken,
      },
      body: image,
    });
    expect(uploadRes.status).toBe(200);
    const { r2Key } = (await uploadRes.json()) as { r2Key: string };

    const stored = await env.ATTACHMENTS_BUCKET.get(r2Key);
    expect(stored).not.toBeNull();

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(200);
    const final = (await finalizeRes.json()) as {
      ticketId: string;
      shareUrl?: string;
    };
    expect(final.ticketId).toBeTruthy();
    expect(final.shareUrl).toBeUndefined();

    const db = createD1(env.D1);
    const ticket = await getTicketById(db, organizationId, final.ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.sourceChannel).toBe("capture");

    const customer = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.email, "reporter@example.com"))
      .get();
    expect(customer).not.toBeNull();
    expect(customer!.organizationId).toBe(organizationId);
  });

  it("receives a Jam webhook for an Intercom conversation and attaches to the existing ticket", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "intercom-reporter@example.com",
      "Intercom Reporter",
      "intercom"
    );
    const existing = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Intercom conversation",
      sourceChannel: "intercom",
      externalSource: "intercom",
      externalId: "conv-123",
    });

    const payload = JSON.stringify({
      jamId: "jam-456",
      jamUrl: "https://jam.dev/c/jam-456",
      teamId: "team-123",
      type: "screenshot",
      createdAt: new Date().toISOString(),
      title: "Button is broken",
      description: "Clicking the submit button does nothing",
      author: {
        email: "intercom-reporter@example.com",
        name: "Intercom Reporter",
      },
      media: { screenshotUrl: "https://jam.dev/media/screen.png" },
      intercom: { conversationId: "conv-123" },
    });
    const svixId = "msg-2";
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string };
    expect(body.ticketId).toBe(existing.id);

    const ticket = await getTicketById(db, organizationId, existing.id);
    expect(ticket).not.toBeNull();
    expect(
      ticket!.events.some((e) =>
        e.message?.textContent?.includes("Clicking the submit button")
      )
    ).toBe(true);
  });

  it("receives a Jam webhook for a Linear issue and attaches to the existing issue", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "linear-reporter@example.com",
      "Linear Reporter",
      "linear"
    );
    const stub = getWorkspaceStub(env, organizationId);
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Linear-imported issue",
      status: "backlog",
      priority: "high",
    });
    const existing = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Linear-imported issue",
      sourceChannel: "linear",
      externalSource: "linear",
      externalId: "linear-456",
      issueId: issue.id,
    });

    const payload = JSON.stringify({
      jamId: "jam-789",
      jamUrl: "https://jam.dev/c/jam-789",
      teamId: "team-123",
      type: "screenshot",
      createdAt: new Date().toISOString(),
      title: "Button is broken",
      description: "Clicking the submit button does nothing",
      author: {
        email: "linear-reporter@example.com",
        name: "Linear Reporter",
      },
      media: { screenshotUrl: "https://jam.dev/media/screen.png" },
      linear: { issueId: "linear-456" },
    });
    const svixId = "msg-3";
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string };
    expect(body.ticketId).toBe(existing.id);

    const ticket = await getTicketById(db, organizationId, existing.id);
    expect(ticket).not.toBeNull();
    expect(ticket!.issueId).toBe(issue.id);
    expect(
      ticket!.events.some((e) =>
        e.message?.textContent?.includes("Clicking the submit button")
      )
    ).toBe(true);
  });

  it("receives a verified Jam webhook and creates a support ticket", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);

    const payload = JSON.stringify({
      jamId: "jam-123",
      jamUrl: "https://jam.dev/c/jam-123",
      teamId: "team-123",
      type: "screenshot",
      createdAt: new Date().toISOString(),
      title: "Button is broken",
      description: "Clicking the submit button does nothing",
      author: {
        email: "reporter@example.com",
        name: "Reporter",
      },
      media: {
        screenshotUrl: "https://media.jam.dev/screenshot.png",
      },
      recordingLink: {
        reference: undefined,
      },
    });

    const svixId = crypto.randomUUID();
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string };
    expect(body.ticketId).toBeTruthy();

    const ticket = await getTicketById(db, organizationId, body.ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.externalSource).toBe("jam");

    const attachments = await db
      .select()
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, body.ticketId));
    expect(attachments.length).toBe(1);
    expect(attachments[0]!.type).toBe("screenshot");
  });

  it("stores Jam debugger artifacts as R2-backed attachments", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);

    const payload = JSON.stringify({
      jamId: "jam-debug-1",
      jamUrl: "https://jam.dev/c/jam-debug-1",
      teamId: "team-123",
      type: "screenshot",
      createdAt: new Date().toISOString(),
      title: "Bug with debugger data",
      author: {
        email: "debug@example.com",
        name: "Debug Reporter",
      },
      media: { screenshotUrl: "https://media.jam.dev/screenshot.png" },
      systemInfo: {
        browser: { name: "Chrome", version: "120.0" },
        os: { name: "macOS", version: "14.0" },
        connection: { effectiveType: "4g", downlinkMbps: 10, rttMs: 20 },
      },
      consoleLogs: [
        { level: "error", message: "Uncaught ReferenceError" },
        { level: "warn", message: "Deprecated API" },
      ],
      networkRequests: [
        {
          url: "https://api.example.com/data",
          method: "GET",
          status: 500,
          duration: 120,
        },
      ],
      userEvents: [{ type: "click", selector: "#submit" }],
    });
    const svixId = "msg-debug";
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticketId: string };

    const attachments = await db
      .select()
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, body.ticketId));
    expect(attachments.length).toBe(5);
    expect(attachments.some((a) => a.type === "screenshot")).toBe(true);
    expect(
      attachments.some((a) => a.type === "debugger_json" && a.r2Key !== null)
    ).toBe(true);
    expect(
      attachments.filter((a) => a.type === "log" && a.r2Key !== null).length
    ).toBe(2);
    expect(
      attachments.some((a) => a.type === "network" && a.r2Key !== null)
    ).toBe(true);
  });

  it("deduplicates a repeated Jam webhook by jamId", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);

    const payload = JSON.stringify({
      jamId: "jam-dedup-1",
      jamUrl: "https://jam.dev/c/jam-dedup-1",
      teamId: "team-123",
      type: "screenshot",
      createdAt: new Date().toISOString(),
      title: "Button is broken",
      description: "Clicking the submit button does nothing",
      author: {
        email: "dedup@example.com",
        name: "Dedup Reporter",
      },
      media: {
        screenshotUrl: "https://media.jam.dev/screenshot.png",
      },
    });
    const svixId = "msg-dedup";
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });
    const res1 = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ticketId: string };

    const res2 = await captureFetch(`/support/webhooks/jam/${publicKey.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": signature,
      },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ticketId: string };
    expect(body2.ticketId).toBe(body1.ticketId);

    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, body1.ticketId));
    expect(events.length).toBe(1);
  });

  it("attaches a capture to an existing support ticket by reference", async () => {
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "existing@example.com",
      "Existing Customer",
      "intercom"
    );
    const existing = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Intercom conversation",
      sourceChannel: "intercom",
      externalSource: "intercom",
    });

    const publicKey = await createPublicKey();
    const { token: sessionToken } = await issueCaptureToken(
      publicKey,
      "https://example.com",
      existing.id
    );

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "Screen recording",
        attachmentType: "screenshot",
        metadata: {
          email: "reporter@example.com",
          description: "The button still does nothing",
        },
      }),
    });
    expect(sessionRes.status).toBe(200);
    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };
    expect(uploadUrl).toBeTruthy();

    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploadRes = await captureFetch(
      `/support/capture/upload/${sessionToken}/screenshot`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "x-vortex-capture-token": sessionToken,
        },
        body: image,
      }
    );
    expect(uploadRes.status).toBe(200);

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(200);
    const final = (await finalizeRes.json()) as { ticketId: string };
    expect(final.ticketId).toBe(existing.id);

    const ticket = await getTicketById(db, organizationId, existing.id);
    expect(ticket).not.toBeNull();
    const events = ticket!.events;
    expect(
      events.some((e) => e.message?.textContent?.includes("still does nothing"))
    ).toBe(true);
  });

  it("deletes stale non-finalized capture sessions", async () => {
    const db = createD1(env.D1);
    const { organizationId: orgId } = await seedWorkspace();
    const publicKey = await createCapturePublicKey(db, orgId, {
      name: "test",
      allowedOrigins: ["https://example.com"],
    });
    const session = await createCaptureSession(db, publicKey.id, orgId, -1);
    const before = await db
      .select()
      .from(supportCaptureSessions)
      .where(eq(supportCaptureSessions.id, session.id))
      .get();
    expect(before).not.toBeNull();

    await expireStaleCaptureSessions(db);

    const after = await db
      .select()
      .from(supportCaptureSessions)
      .where(eq(supportCaptureSessions.id, session.id))
      .get();
    expect(after).toBeUndefined();
  });

  it("attaches a capture to an existing workspace issue by reference", async () => {
    const db = createD1(env.D1);
    const stub = getWorkspaceStub(env, organizationId);
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Linear-imported bug",
      status: "backlog",
      priority: "high",
    });

    const publicKey = await createPublicKey();
    const { token: sessionToken } = await issueCaptureToken(
      publicKey,
      "https://example.com",
      issue.id
    );

    const sessionRes = await captureFetch("/support/capture/upload-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vortex-capture-token": sessionToken,
      },
      body: JSON.stringify({
        title: "Screen recording",
        attachmentType: "screenshot",
        metadata: {
          email: "reporter@example.com",
          description: "The button still does nothing",
        },
      }),
    });
    expect(sessionRes.status).toBe(200);

    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploadRes = await captureFetch(
      `/support/capture/upload/${sessionToken}/screenshot`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "x-vortex-capture-token": sessionToken,
        },
        body: image,
      }
    );
    expect(uploadRes.status).toBe(200);

    const finalizeRes = await captureFetch("/support/capture/finalize", {
      method: "POST",
      headers: { "x-vortex-capture-token": sessionToken },
    });
    expect(finalizeRes.status).toBe(200);
    const final = (await finalizeRes.json()) as { ticketId: string };

    const ticket = await getTicketById(db, organizationId, final.ticketId);
    expect(ticket).not.toBeNull();
    expect(ticket!.issueId).toBe(issue.id);
    expect(ticket!.sourceChannel).toBe("capture");
  });

  it("receives an intercom.recorder.recorded webhook", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "intercom-customer@example.com",
      null,
      "intercom"
    );
    const existing = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Intercom issue",
      sourceChannel: "intercom",
      externalId: "conversation-123",
      externalSource: "intercom",
    });

    const payload = JSON.stringify({
      conversationId: "conversation-123",
      jamId: "jam-intercom-1",
      jamUrl: "https://jam.dev/c/jam-intercom-1",
    });
    const svixId = crypto.randomUUID();
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(
      `/support/webhooks/jam/${publicKey.id}/intercom/recorded`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": signature,
        },
        body: payload,
      }
    );
    expect(res.status).toBe(200);

    const ticket = await getTicketById(db, organizationId, existing.id);
    expect(
      ticket!.events.some((e) =>
        e.message?.textContent?.includes("https://jam.dev/c/jam-intercom-1")
      )
    ).toBe(true);
  });

  it("receives an intercom.recorder.opted_out webhook", async () => {
    const publicKey = await createPublicKey();
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "opt-out-customer@example.com",
      null,
      "intercom"
    );
    const existing = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Intercom opt-out",
      sourceChannel: "intercom",
      externalId: "conversation-456",
      externalSource: "intercom",
    });

    const payload = JSON.stringify({
      conversationId: "conversation-456",
    });
    const svixId = crypto.randomUUID();
    const svixTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signJamWebhook({
      payload,
      svixId,
      svixTimestamp,
      secret: publicKey.webhookSecret,
    });

    const res = await captureFetch(
      `/support/webhooks/jam/${publicKey.id}/intercom/opted-out`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": signature,
        },
        body: payload,
      }
    );
    expect(res.status).toBe(200);

    const ticket = await getTicketById(db, organizationId, existing.id);
    expect(
      ticket!.events.some((e) =>
        e.message?.textContent?.includes("declined to record")
      )
    ).toBe(true);
  });
});

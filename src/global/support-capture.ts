import { and, eq, lt, ne } from "drizzle-orm";

import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import { supportCapturePublicKeys, supportCaptureSessions } from "./schema.js";

export type CapturePublicKeyInput = {
  name: string;
  allowedOrigins: string[];
};

export type CaptureSessionStatus =
  | "pending"
  | "uploading"
  | "finalized"
  | "expired";

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return `whsec_${btoa(binary)}`;
}

export async function getCapturePublicKeyById(db: D1Client, id: string) {
  const row = await db
    .select()
    .from(supportCapturePublicKeys)
    .where(eq(supportCapturePublicKeys.id, id))
    .get();
  return row ? parseCapturePublicKey(row) : null;
}

export async function createCapturePublicKey(
  db: D1Client,
  organizationId: string,
  input: CapturePublicKeyInput
) {
  const id = crypto.randomUUID();
  const key = `pil_${crypto.randomUUID().replace(/-/g, "")}`;
  const webhookSecret = generateWebhookSecret();
  const now = new Date().toISOString();
  await db.insert(supportCapturePublicKeys).values({
    id,
    organizationId,
    name: input.name,
    key,
    webhookSecret,
    allowedOrigins: JSON.stringify(input.allowedOrigins),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  const row = await db
    .select()
    .from(supportCapturePublicKeys)
    .where(eq(supportCapturePublicKeys.id, id))
    .get();
  if (!row) {
    throw new VortexError({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Failed to create capture public key",
    });
  }
  return parseCapturePublicKey(row);
}

export async function listCapturePublicKeys(
  db: D1Client,
  organizationId: string
) {
  const rows = await db
    .select()
    .from(supportCapturePublicKeys)
    .where(eq(supportCapturePublicKeys.organizationId, organizationId))
    .orderBy(supportCapturePublicKeys.createdAt)
    .all();
  return rows.map(parseCapturePublicKey);
}

export async function revokeCapturePublicKey(
  db: D1Client,
  organizationId: string,
  id: string
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(supportCapturePublicKeys)
    .set({ isActive: false, updatedAt: now })
    .where(
      and(
        eq(supportCapturePublicKeys.id, id),
        eq(supportCapturePublicKeys.organizationId, organizationId)
      )
    )
    .returning();
  if (!row) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Capture public key not found",
    });
  }
  return parseCapturePublicKey(row);
}

export async function findCapturePublicKeyByKey(db: D1Client, key: string) {
  const row = await db
    .select()
    .from(supportCapturePublicKeys)
    .where(
      and(
        eq(supportCapturePublicKeys.key, key),
        eq(supportCapturePublicKeys.isActive, true)
      )
    )
    .get();
  return row ? parseCapturePublicKey(row) : null;
}

export async function createCaptureSession(
  db: D1Client,
  publicKeyId: string,
  organizationId: string,
  expiresMinutes = 30,
  metadata: Record<string, unknown> = {}
) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + expiresMinutes * 60 * 1000
  ).toISOString();
  await db.insert(supportCaptureSessions).values({
    id,
    organizationId,
    publicKeyId,
    customerId: null,
    ticketId: null,
    status: "pending",
    metadata: JSON.stringify(metadata),
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const row = await db
    .select()
    .from(supportCaptureSessions)
    .where(eq(supportCaptureSessions.id, id))
    .get();
  if (!row) {
    throw new VortexError({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Failed to create capture session",
    });
  }
  return parseCaptureSession(row);
}

export async function getCaptureSession(db: D1Client, id: string) {
  const row = await db
    .select()
    .from(supportCaptureSessions)
    .where(eq(supportCaptureSessions.id, id))
    .get();
  return row ? parseCaptureSession(row) : null;
}

export async function updateCaptureSessionMetadata(
  db: D1Client,
  id: string,
  metadata: Record<string, unknown>
) {
  const now = new Date().toISOString();
  const existing = await getCaptureSession(db, id);
  if (!existing) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Capture session not found",
    });
  }
  const merged = { ...existing.metadata, ...metadata };
  const [row] = await db
    .update(supportCaptureSessions)
    .set({ metadata: JSON.stringify(merged), updatedAt: now })
    .where(eq(supportCaptureSessions.id, id))
    .returning();
  if (!row) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Capture session not found",
    });
  }
  return parseCaptureSession(row);
}

export async function updateCaptureSessionStatus(
  db: D1Client,
  id: string,
  status: CaptureSessionStatus
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(supportCaptureSessions)
    .set({ status, updatedAt: now })
    .where(eq(supportCaptureSessions.id, id))
    .returning();
  if (!row) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Capture session not found",
    });
  }
  return parseCaptureSession(row);
}

export async function expireStaleCaptureSessions(
  db: D1Client,
  before = new Date().toISOString()
) {
  await db
    .delete(supportCaptureSessions)
    .where(
      and(
        ne(supportCaptureSessions.status, "finalized"),
        lt(supportCaptureSessions.expiresAt, before)
      )
    );
}

export async function finalizeCaptureSession(
  db: D1Client,
  id: string,
  {
    customerId,
    ticketId,
    status = "finalized",
  }: {
    customerId?: string | null;
    ticketId?: string | null;
    status?: CaptureSessionStatus;
  }
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(supportCaptureSessions)
    .set({
      customerId: customerId ?? null,
      ticketId: ticketId ?? null,
      status,
      updatedAt: now,
    })
    .where(eq(supportCaptureSessions.id, id))
    .returning();
  if (!row) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Capture session not found",
    });
  }
  return parseCaptureSession(row);
}

function parseCapturePublicKey(row: {
  id: string;
  organizationId: string;
  name: string;
  key: string;
  webhookSecret: string | null;
  allowedOrigins: string;
  isActive: number | boolean;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    key: row.key,
    webhookSecret: row.webhookSecret,
    allowedOrigins: JSON.parse(row.allowedOrigins) as string[],
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCaptureSession(row: {
  id: string;
  organizationId: string;
  publicKeyId: string;
  customerId: string | null;
  ticketId: string | null;
  status: string;
  metadata: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    publicKeyId: row.publicKeyId,
    customerId: row.customerId,
    ticketId: row.ticketId,
    status: row.status as CaptureSessionStatus,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

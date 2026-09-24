import { and, eq } from "drizzle-orm";

import { hmacSha256Hex, timingSafeEqualHex } from "./crypto.js";
import type { D1Client } from "./db.js";
import { supportWidgetKeys, supportWidgetSessions } from "./schema.js";

export type SupportWidgetKey = {
  id: string;
  organizationId: string;
  key: string;
  hmacSecret: string;
  name: string;
  allowedOrigins: string[];
  greeting: string | null;
  brandColor: string | null;
  requireEmail: boolean;
  requireChallenge: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportWidgetSession = {
  id: string;
  organizationId: string;
  widgetKeyId: string;
  token: string;
  customerId: string | null;
  ticketId: string | null;
  externalId: string | null;
  identityVerified: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type WidgetKeyRow = typeof supportWidgetKeys.$inferSelect;
type WidgetSessionRow = typeof supportWidgetSessions.$inferSelect;

function rowToKey(row: WidgetKeyRow): SupportWidgetKey {
  return { ...row, allowedOrigins: JSON.parse(row.allowedOrigins) as string[] };
}

export async function createWidgetKey(
  db: D1Client,
  organizationId: string,
  input: {
    name: string;
    allowedOrigins: string[];
    greeting?: string | null;
    brandColor?: string | null;
    requireEmail: boolean;
    requireChallenge: boolean;
    createdBy: string | null;
  }
): Promise<SupportWidgetKey> {
  const id = crypto.randomUUID();
  const key = `wgt_${crypto.randomUUID().replace(/-/g, "")}`;
  const hmacSecret = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const row: WidgetKeyRow = {
    id,
    organizationId,
    key,
    hmacSecret,
    name: input.name,
    allowedOrigins: JSON.stringify(input.allowedOrigins),
    greeting: input.greeting ?? null,
    brandColor: input.brandColor ?? null,
    requireEmail: input.requireEmail,
    requireChallenge: input.requireChallenge,
    isActive: true,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(supportWidgetKeys).values(row);
  return rowToKey(row);
}

export async function listWidgetKeys(
  db: D1Client,
  organizationId: string
): Promise<SupportWidgetKey[]> {
  const rows = await db
    .select()
    .from(supportWidgetKeys)
    .where(eq(supportWidgetKeys.organizationId, organizationId));
  return rows.map(rowToKey);
}

export async function findWidgetKeyByKey(
  db: D1Client,
  key: string
): Promise<SupportWidgetKey | null> {
  const [row] = await db
    .select()
    .from(supportWidgetKeys)
    .where(eq(supportWidgetKeys.key, key))
    .limit(1);
  return row ? rowToKey(row) : null;
}

export async function revokeWidgetKey(
  db: D1Client,
  organizationId: string,
  keyId: string
): Promise<SupportWidgetKey | null> {
  const [row] = await db
    .select()
    .from(supportWidgetKeys)
    .where(
      and(
        eq(supportWidgetKeys.id, keyId),
        eq(supportWidgetKeys.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!row) return null;
  await db
    .update(supportWidgetKeys)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(supportWidgetKeys.id, keyId));
  return rowToKey({ ...row, isActive: false });
}

export async function verifyWidgetIdentityHash(
  widgetKey: SupportWidgetKey,
  identifier: string,
  identifierHash: string
): Promise<boolean> {
  const expected = await hmacSha256Hex(widgetKey.hmacSecret, identifier);
  return timingSafeEqualHex(expected, identifierHash);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createWidgetSession(
  db: D1Client,
  organizationId: string,
  input: {
    widgetKeyId: string;
    customerId?: string | null;
    externalId?: string | null;
    identityVerified: boolean;
  }
): Promise<SupportWidgetSession> {
  const now = new Date().toISOString();
  const row: WidgetSessionRow = {
    id: crypto.randomUUID(),
    organizationId,
    widgetKeyId: input.widgetKeyId,
    token: `wgs_${crypto.randomUUID().replace(/-/g, "")}`,
    customerId: input.customerId ?? null,
    ticketId: null,
    externalId: input.externalId ?? null,
    identityVerified: input.identityVerified,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(supportWidgetSessions).values(row);
  return row;
}

export async function findWidgetSessionByToken(
  db: D1Client,
  token: string
): Promise<SupportWidgetSession | null> {
  const [row] = await db
    .select()
    .from(supportWidgetSessions)
    .where(eq(supportWidgetSessions.token, token))
    .limit(1);
  if (!row || row.expiresAt <= new Date().toISOString()) return null;
  return row;
}

export async function updateWidgetSession(
  db: D1Client,
  sessionId: string,
  patch: {
    customerId?: string | null;
    ticketId?: string | null;
    externalId?: string | null;
    identityVerified?: boolean;
  }
): Promise<void> {
  await db
    .update(supportWidgetSessions)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(supportWidgetSessions.id, sessionId));
}

import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { notionInstallations } from "./schema.js";

export async function updateNotionInstallationVerificationToken(
  db: D1Client,
  id: string,
  verificationToken: string
) {
  await db
    .update(notionInstallations)
    .set({
      verificationToken,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(notionInstallations.id, id));
}

export function findNotionInstallation(
  db: D1Client,
  organizationId: string,
  workspaceId: string
) {
  return db
    .select()
    .from(notionInstallations)
    .where(
      and(
        eq(notionInstallations.organizationId, organizationId),
        eq(notionInstallations.workspaceId, workspaceId)
      )
    )
    .get();
}

export async function createNotionInstallation(
  db: D1Client,
  organizationId: string,
  workspaceId: string,
  token: string,
  verificationToken?: string | null
) {
  const id = crypto.randomUUID();
  await db.insert(notionInstallations).values({
    id,
    organizationId,
    workspaceId,
    token,
    verificationToken: verificationToken ?? null,
  });
  return db
    .select()
    .from(notionInstallations)
    .where(eq(notionInstallations.id, id))
    .get();
}

export async function upsertNotionInstallation(
  db: D1Client,
  organizationId: string,
  workspaceId: string,
  token: string,
  verificationToken?: string | null
) {
  const existing = await findNotionInstallation(
    db,
    organizationId,
    workspaceId
  );
  if (existing) {
    await db
      .update(notionInstallations)
      .set({
        token,
        verificationToken: verificationToken ?? existing.verificationToken,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(notionInstallations.id, existing.id));
    return findNotionInstallation(db, organizationId, workspaceId);
  }
  return createNotionInstallation(
    db,
    organizationId,
    workspaceId,
    token,
    verificationToken
  );
}

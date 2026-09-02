import { and, eq } from "drizzle-orm";
import { D1Client } from "./db.js";
import { attachments } from "./schema.js";

export function listAttachments(
  db: D1Client,
  workspaceId: string,
  issueId: string
) {
  return db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.issueId, issueId)
      )
    )
    .all();
}

export function getAttachment(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, id))
    )
    .get();
}

export async function createAttachment(
  db: D1Client,
  workspaceId: string,
  values: {
    issueId: string;
    linearId: string;
    url: string;
    title?: string | null;
    subtitle?: string | null;
    r2Key?: string | null;
    createdAt?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(attachments).values({
    id,
    workspaceId,
    issueId: values.issueId,
    linearId: values.linearId,
    url: values.url,
    title: values.title ?? null,
    subtitle: values.subtitle ?? null,
    r2Key: values.r2Key ?? null,
    createdAt: values.createdAt ?? ts,
  });
  return getAttachment(db, workspaceId, id);
}

export async function setAttachmentR2Key(
  db: D1Client,
  workspaceId: string,
  id: string,
  r2Key: string
) {
  await db
    .update(attachments)
    .set({ r2Key })
    .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, id)));
}

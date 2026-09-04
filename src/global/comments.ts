import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { comments } from "./schema.js";

export function listComments(
  db: D1Client,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.organizationId, organizationId),
        eq(comments.issueId, issueId)
      )
    )
    .all();
}

export function getComment(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(comments)
    .where(
      and(eq(comments.organizationId, organizationId), eq(comments.id, id))
    )
    .get();
}

export function findCommentByExternalId(
  db: D1Client,
  organizationId: string,
  externalSource: string,
  externalId: string
) {
  return db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.organizationId, organizationId),
        eq(comments.externalSource, externalSource),
        eq(comments.externalId, externalId)
      )
    )
    .get();
}

export async function createComment(
  db: D1Client,
  organizationId: string,
  values: {
    issueId: string;
    authorId?: string;
    body: string;
    externalId?: string;
    externalSource?: string;
    externalAuthor?: string;
    createdAt?: string;
    updatedAt?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(comments).values({
    id,
    organizationId,
    issueId: values.issueId,
    authorId: values.authorId ?? null,
    body: values.body,
    externalId: values.externalId ?? null,
    externalSource: values.externalSource ?? null,
    externalAuthor: values.externalAuthor ?? null,
    createdAt: values.createdAt ?? ts,
    updatedAt: values.updatedAt ?? ts,
  });
  return getComment(db, organizationId, id);
}

export async function updateComment(
  db: D1Client,
  organizationId: string,
  id: string,
  values: {
    body: string;
    externalId?: string;
    externalSource?: string;
    externalAuthor?: string;
    updatedAt?: string;
  }
) {
  const ts = new Date().toISOString();
  await db
    .update(comments)
    .set({
      body: values.body,
      externalId: values.externalId,
      externalSource: values.externalSource,
      externalAuthor: values.externalAuthor,
      updatedAt: values.updatedAt ?? ts,
    })
    .where(
      and(eq(comments.organizationId, organizationId), eq(comments.id, id))
    );
  return getComment(db, organizationId, id);
}

export async function deleteComment(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(comments)
    .where(
      and(eq(comments.organizationId, organizationId), eq(comments.id, id))
    );
}

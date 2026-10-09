import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { sendEmail } from "../email/send.js";
// react-email is lazy-imported on first send to keep its ~100ms startup
// cost out of deploy validation (see support-channels.ts).
import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import {
  changelogEntries,
  changelogEntryLinks,
  supportCustomers,
  supportTicketVotes,
} from "./schema.js";

export type ChangelogEntry = typeof changelogEntries.$inferSelect;
export type ChangelogEntryLink = typeof changelogEntryLinks.$inferSelect;

export type ChangelogLinkInput = {
  ticketId?: string;
  issueId?: string;
};

export type ChangelogEntryWithLinks = ChangelogEntry & {
  links: ChangelogEntryLink[];
};

async function attachLinks(
  db: D1Client,
  entries: ChangelogEntry[]
): Promise<ChangelogEntryWithLinks[]> {
  if (entries.length === 0) return [];
  const links = await db
    .select()
    .from(changelogEntryLinks)
    .where(
      inArray(
        changelogEntryLinks.entryId,
        entries.map((e) => e.id)
      )
    );
  return entries.map((entry) => ({
    ...entry,
    links: links.filter((l) => l.entryId === entry.id),
  }));
}

export async function createChangelogEntry(
  db: D1Client,
  organizationId: string,
  input: {
    title: string;
    body: string;
    labels?: string[];
    links?: ChangelogLinkInput[];
    publish?: boolean;
  }
): Promise<ChangelogEntryWithLinks> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(changelogEntries).values({
    id,
    organizationId,
    title: input.title,
    body: input.body,
    labels: JSON.stringify(input.labels ?? []),
    publishedAt: input.publish ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  await setChangelogLinks(db, id, input.links ?? []);
  const [entry] = await attachLinks(db, [
    (await getChangelogEntry(db, organizationId, id))!,
  ]);
  return entry;
}

export async function getChangelogEntry(
  db: D1Client,
  organizationId: string,
  id: string
): Promise<ChangelogEntry | null> {
  const [entry] = await db
    .select()
    .from(changelogEntries)
    .where(
      and(
        eq(changelogEntries.id, id),
        eq(changelogEntries.organizationId, organizationId)
      )
    )
    .limit(1);
  return entry ?? null;
}

export async function getChangelogEntryWithLinks(
  db: D1Client,
  organizationId: string,
  id: string
): Promise<ChangelogEntryWithLinks | null> {
  const entry = await getChangelogEntry(db, organizationId, id);
  if (!entry) return null;
  const [withLinks] = await attachLinks(db, [entry]);
  return withLinks;
}

export async function listChangelogEntries(
  db: D1Client,
  organizationId: string,
  options: { publishedOnly: boolean; limit: number; cursor?: string }
): Promise<{ entries: ChangelogEntryWithLinks[]; nextCursor: string | null }> {
  const conditions = [eq(changelogEntries.organizationId, organizationId)];
  if (options.publishedOnly) {
    conditions.push(isNotNull(changelogEntries.publishedAt));
  }
  const limit = Math.max(1, Math.min(options.limit, 200));
  const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
  const safeOffset = Number.isNaN(offset) || offset < 0 ? 0 : offset;

  const rows = await db
    .select()
    .from(changelogEntries)
    .where(and(...conditions))
    .orderBy(
      desc(changelogEntries.publishedAt),
      desc(changelogEntries.createdAt)
    )
    .limit(limit + 1)
    .offset(safeOffset);

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, -1) : rows;
  return {
    entries: await attachLinks(db, sliced),
    nextCursor: hasMore ? String(safeOffset + limit) : null,
  };
}

export async function updateChangelogEntry(
  db: D1Client,
  organizationId: string,
  id: string,
  input: {
    title?: string;
    body?: string;
    labels?: string[];
    links?: ChangelogLinkInput[];
  }
): Promise<ChangelogEntryWithLinks | null> {
  const existing = await getChangelogEntry(db, organizationId, id);
  if (!existing) return null;

  await db
    .update(changelogEntries)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.labels !== undefined && {
        labels: JSON.stringify(input.labels),
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(changelogEntries.id, id),
        eq(changelogEntries.organizationId, organizationId)
      )
    );

  if (input.links !== undefined) {
    await db
      .delete(changelogEntryLinks)
      .where(eq(changelogEntryLinks.entryId, id));
    await setChangelogLinks(db, id, input.links);
  }

  const updated = await getChangelogEntry(db, organizationId, id);
  const [withLinks] = await attachLinks(db, [updated!]);
  return withLinks;
}

async function setChangelogLinks(
  db: D1Client,
  entryId: string,
  links: ChangelogLinkInput[]
) {
  const rows = links
    .filter((l) => l.ticketId || l.issueId)
    .map((l) => ({
      id: crypto.randomUUID(),
      entryId,
      ticketId: l.ticketId ?? null,
      issueId: l.issueId ?? null,
    }));
  if (rows.length > 0) {
    await db.insert(changelogEntryLinks).values(rows);
  }
}

export async function deleteChangelogEntry(
  db: D1Client,
  organizationId: string,
  id: string
): Promise<boolean> {
  const rows = await db
    .delete(changelogEntries)
    .where(
      and(
        eq(changelogEntries.id, id),
        eq(changelogEntries.organizationId, organizationId)
      )
    )
    .returning({ id: changelogEntries.id });
  return rows.length > 0;
}

export async function setChangelogPublished(
  db: D1Client,
  organizationId: string,
  id: string,
  published: boolean
): Promise<ChangelogEntryWithLinks | null> {
  const existing = await getChangelogEntry(db, organizationId, id);
  if (!existing) return null;
  await db
    .update(changelogEntries)
    .set({
      publishedAt: published
        ? (existing.publishedAt ?? new Date().toISOString())
        : null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(changelogEntries.id, id),
        eq(changelogEntries.organizationId, organizationId)
      )
    );
  const updated = await getChangelogEntry(db, organizationId, id);
  const [withLinks] = await attachLinks(db, [updated!]);
  return withLinks;
}

/** Voter emails on the entry's linked tickets, minus opted-out customers. */
export async function changelogNotifyRecipients(
  db: D1Client,
  organizationId: string,
  entry: ChangelogEntryWithLinks
): Promise<string[]> {
  const ticketIds = entry.links
    .map((l) => l.ticketId)
    .filter((id): id is string => id !== null);
  if (ticketIds.length === 0) return [];

  const votes = await db
    .select({ voterEmail: supportTicketVotes.voterEmail })
    .from(supportTicketVotes)
    .where(inArray(supportTicketVotes.ticketId, ticketIds));
  const emails = [...new Set(votes.map((v) => v.voterEmail))];
  if (emails.length === 0) return [];

  const optedOut = await db
    .select({ email: supportCustomers.email })
    .from(supportCustomers)
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.emailOptOut, true),
        inArray(supportCustomers.email, emails)
      )
    );
  const optedOutSet = new Set(optedOut.map((c) => c.email));
  return emails.filter((e) => !optedOutSet.has(e));
}

/**
 * Close-the-loop: email voters on tickets linked to a just-published entry.
 * Honors emailOptOut on the customer record — voters without a customer
 * record are treated as opted-in (they voted, they want to know).
 * Returns the addresses notified.
 */
export async function notifyVotersOfChangelogEntry(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  entry: ChangelogEntryWithLinks
): Promise<string[]> {
  if (!env.EMAIL || !env.EMAIL_FROM) return [];
  const recipients = await changelogNotifyRecipients(db, organizationId, entry);
  const unsubscribeUrl = `${env.PUBLIC_API_URL ?? ""}/support/unsubscribe`;
  const text = `${entry.body}\n\n---\nYou asked for this. Unsubscribe: ${unsubscribeUrl}`;
  const { renderChangelogShipped } = await import("../email/templates.js");
  const html = await renderChangelogShipped(entry.title, entry.body);

  const notified: string[] = [];
  for (const to of recipients) {
    try {
      await sendEmail(env, {
        from: env.EMAIL_FROM,
        to,
        subject: `Shipped: ${entry.title}`,
        text,
        html,
      });
      notified.push(to);
    } catch {
      // best-effort notify — a failed send doesn't block publish
    }
  }
  return notified;
}

import { and, count, eq, inArray } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  githubUsers,
  issueSubscribers,
  linearUsers,
  notifications,
  user,
} from "./schema.js";
import { getWorkspaceMembership } from "./workspaces.js";

export type NotificationType =
  | "issue_created"
  | "issue_updated"
  | "issue_deleted"
  | "comment_created";

export type RecipientType = "user" | "agent";

export interface NotificationInput {
  workspaceId: string;
  recipientId: string;
  recipientType?: RecipientType;
  issueId: string;
  type: NotificationType;
  metadata?: Record<string, unknown>;
}

export async function createNotification(
  db: D1Client,
  input: NotificationInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(notifications).values({
    id,
    workspaceId: input.workspaceId,
    recipientId: input.recipientId,
    recipientType: input.recipientType ?? "user",
    issueId: input.issueId,
    type: input.type,
    metadata:
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    read: false,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(notifications).where(eq(notifications.id, id)).get();
}

export async function getNotificationsForRecipient(
  db: D1Client,
  workspaceId: string,
  recipientId: string,
  recipientType: RecipientType,
  options: { unreadOnly?: boolean; limit?: number } = {}
) {
  const conditions = [
    eq(notifications.workspaceId, workspaceId),
    eq(notifications.recipientId, recipientId),
    eq(notifications.recipientType, recipientType),
  ];
  if (options.unreadOnly) {
    conditions.push(eq(notifications.read, false));
  }
  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(notifications.createdAt)
    .limit(options.limit ?? 100)
    .all();
}

export async function getUnreadNotificationCount(
  db: D1Client,
  workspaceId: string,
  recipientId: string,
  recipientType: RecipientType
) {
  const result = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientId, recipientId),
        eq(notifications.recipientType, recipientType),
        eq(notifications.read, false)
      )
    )
    .get();
  return result?.count ?? 0;
}

export async function markNotificationRead(
  db: D1Client,
  workspaceId: string,
  recipientId: string,
  recipientType: RecipientType,
  notificationId: string
) {
  const existing = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientId, recipientId),
        eq(notifications.recipientType, recipientType)
      )
    )
    .get();
  if (!existing) return null;

  await db
    .update(notifications)
    .set({ read: true, updatedAt: new Date().toISOString() })
    .where(eq(notifications.id, notificationId));
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .get();
}

export async function markAllNotificationsRead(
  db: D1Client,
  workspaceId: string,
  recipientId: string,
  recipientType: RecipientType
) {
  await db
    .update(notifications)
    .set({ read: true, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.recipientId, recipientId),
        eq(notifications.recipientType, recipientType),
        eq(notifications.read, false)
      )
    );
}

export async function resolveIssueRecipients(
  db: D1Client,
  workspaceId: string,
  issue: { id: string; assigneeId: string | null },
  excludeRecipientId?: string
): Promise<string[]> {
  const recipients = new Set<string>();

  if (issue.assigneeId) {
    const membership = await getWorkspaceMembership(
      db,
      workspaceId,
      issue.assigneeId
    );
    if (membership) {
      recipients.add(issue.assigneeId);
    } else {
      const github = await db
        .select({ userId: githubUsers.userId })
        .from(githubUsers)
        .where(
          and(
            eq(githubUsers.workspaceId, workspaceId),
            eq(githubUsers.githubLogin, issue.assigneeId)
          )
        )
        .get();
      if (github) {
        recipients.add(github.userId);
      } else {
        const linear = await db
          .select({ email: linearUsers.email })
          .from(linearUsers)
          .where(
            and(
              eq(linearUsers.workspaceId, workspaceId),
              eq(linearUsers.linearId, issue.assigneeId)
            )
          )
          .get();
        if (linear?.email) {
          const matchedUser = await db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, linear.email))
            .get();
          if (matchedUser) {
            recipients.add(matchedUser.id);
          }
        }
      }
    }
  }

  const subscribers = await db
    .select({ linearUserId: issueSubscribers.linearUserId })
    .from(issueSubscribers)
    .where(
      and(
        eq(issueSubscribers.workspaceId, workspaceId),
        eq(issueSubscribers.issueId, issue.id)
      )
    )
    .all();

  if (subscribers.length > 0) {
    const linearIds = subscribers.map((s) => s.linearUserId);
    const linearRows = await db
      .select({ email: linearUsers.email })
      .from(linearUsers)
      .where(
        and(
          eq(linearUsers.workspaceId, workspaceId),
          inArray(linearUsers.linearId, linearIds)
        )
      )
      .all();

    const emails = linearRows
      .map((row) => row.email)
      .filter(
        (email): email is string =>
          typeof email === "string" && email.length > 0
      );

    if (emails.length > 0) {
      const matchedUsers = await db
        .select({ id: user.id })
        .from(user)
        .where(inArray(user.email, emails))
        .all();
      for (const matchedUser of matchedUsers) {
        recipients.add(matchedUser.id);
      }
    }
  }

  if (excludeRecipientId) {
    recipients.delete(excludeRecipientId);
  }

  return [...recipients];
}

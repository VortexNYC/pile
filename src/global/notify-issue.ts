import type { AppEnv } from "../types/env.js";
import { createD1 } from "./db.js";
import {
  createNotification,
  resolveIssueRecipients,
  type NotificationType,
} from "./notifications.js";

async function notifyRecipients(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  type: NotificationType,
  actorId?: string
) {
  const db = createD1(env.D1);
  const recipients = await resolveIssueRecipients(
    db,
    organizationId,
    issue,
    actorId
  );
  await Promise.all(
    recipients.map((recipientId) =>
      createNotification(db, {
        organizationId,
        recipientId,
        recipientType: "user",
        issueId: issue.id,
        type,
      })
    )
  );
}

export async function notifyIssueCreated(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  actorId?: string
) {
  return notifyRecipients(env, organizationId, issue, "issue_created", actorId);
}

export async function notifyIssueUpdated(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  actorId?: string
) {
  return notifyRecipients(env, organizationId, issue, "issue_updated", actorId);
}

export async function notifyIssueDeleted(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  actorId?: string
) {
  return notifyRecipients(env, organizationId, issue, "issue_deleted", actorId);
}

export async function notifyCommentCreated(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  actorId?: string
) {
  return notifyRecipients(
    env,
    organizationId,
    issue,
    "comment_created",
    actorId
  );
}

export async function notifyMany(
  env: AppEnv,
  organizationId: string,
  issue: { id: string; assigneeId: string | null },
  type: NotificationType,
  actorId?: string
) {
  return notifyRecipients(env, organizationId, issue, type, actorId);
}

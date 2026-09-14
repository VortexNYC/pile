import { and, eq } from "drizzle-orm";

import { createD1, type D1Client } from "../global/db.js";
import { supportConversations } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { Comment } from "../types/workspace.js";
import { captureSlackAttachments } from "./attachments.js";

export interface SlackFileAttachment {
  url?: string;
  name?: string;
  mimeType?: string;
  fetchData?: () => Promise<Buffer | ArrayBuffer>;
}

export interface SlackMessageRaw {
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  team?: string;
  team_id?: string;
  user?: string;
  text?: string;
}

export async function findSupportConversation(
  db: D1Client,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.organizationId, organizationId),
        eq(supportConversations.issueId, issueId)
      )
    )
    .get();
}

export async function storeSupportConversation(
  db: D1Client,
  values: {
    organizationId: string;
    slackTeamId: string;
    slackChannelId: string;
    slackThreadTs: string;
    issueId: string;
    isExternal?: boolean;
  }
) {
  const existing = await db
    .select()
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.organizationId, values.organizationId),
        eq(supportConversations.slackTeamId, values.slackTeamId),
        eq(supportConversations.slackChannelId, values.slackChannelId),
        eq(supportConversations.slackThreadTs, values.slackThreadTs)
      )
    )
    .get();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(supportConversations).values({
    id,
    organizationId: values.organizationId,
    slackTeamId: values.slackTeamId,
    slackChannelId: values.slackChannelId,
    slackThreadTs: values.slackThreadTs,
    issueId: values.issueId,
    isExternal: values.isExternal ?? true,
    createdAt: ts,
    updatedAt: ts,
  });
  return { id, ...values, supportTicketId: null, createdAt: ts, updatedAt: ts };
}

export async function createSlackComment(
  env: WorkerEnv,
  organizationId: string,
  issueId: string,
  values: {
    body: string;
    externalId: string;
    externalAuthor: string;
    internal?: boolean;
    createdAt?: string;
  }
): Promise<Comment> {
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(organizationId);

  const issue = await stub.getIssue(issueId);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found for Slack thread reply",
    });
  }

  const comment = await stub.createComment({
    issueId,
    body: values.body,
    internal: values.internal ?? false,
    externalId: values.externalId,
    externalSource: "slack",
    externalAuthor: values.externalAuthor,
    createdAt: values.createdAt,
    updatedAt: values.createdAt,
  });
  if (!comment) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Failed to create Slack thread comment",
    });
  }

  await stub.indexComment({
    id: comment.id,
    issueId,
    teamId: issue.teamId,
    body: comment.body,
    createdAt: comment.createdAt,
  });

  return comment as Comment;
}

export async function handleSlackThreadMessage(
  env: WorkerEnv,
  thread: { channelId: string; id: string },
  message: {
    id: string;
    text?: string;
    attachments: SlackFileAttachment[];
    raw: unknown;
    author?: { userId?: string; userName?: string };
  }
): Promise<void> {
  const raw = message.raw as Record<string, unknown>;
  const teamId = rawTeamId(raw);
  const channelId =
    typeof raw.channel === "string" ? raw.channel : thread.channelId;
  const replyTs = typeof raw.ts === "string" ? raw.ts : undefined;
  const threadTs = slackThreadTs(raw, channelId);
  if (!teamId || !channelId || !replyTs || !threadTs) return;

  const db = createD1(env.D1);
  const conversation = await db
    .select()
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.slackTeamId, teamId),
        eq(supportConversations.slackChannelId, channelId),
        eq(supportConversations.slackThreadTs, threadTs)
      )
    )
    .get();
  if (!conversation) return;

  const body = (message.text ?? "").trim();
  if (!body) return;

  const author = message.author;
  const externalAuthor = `${teamId}:${author?.userId ?? "unknown"}`;
  const createdAt = slackTsToIso(replyTs);

  await createSlackComment(
    env,
    conversation.organizationId,
    conversation.issueId,
    {
      body,
      externalId: replyTs,
      externalAuthor,
      internal: false,
      createdAt,
    }
  );

  await captureSlackAttachments(
    env,
    conversation.organizationId,
    conversation.issueId,
    message
  );
}

function rawTeamId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.team_id === "string" && raw.team_id) return raw.team_id;
  if (typeof raw.team === "string" && raw.team) return raw.team;
  return undefined;
}

function slackThreadTs(
  raw: Record<string, unknown>,
  channelId: string
): string | undefined {
  if (typeof raw.thread_ts === "string") return raw.thread_ts;
  if (channelId.startsWith("D") || channelId.startsWith("G")) return "";
  return typeof raw.ts === "string" ? raw.ts : undefined;
}

function slackTsToIso(ts: string): string | undefined {
  const [seconds] = ts.split(".");
  const parsed = Number(seconds);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed * 1000).toISOString();
}

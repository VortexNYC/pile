import { and, eq, or } from "drizzle-orm";

import type { D1Client } from "../global/db.js";
import { supportConversations } from "../global/schema.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { IssueInput } from "../types/workspace.js";
import { slackOrgForTeam } from "./bot.js";

const SNOOZE_MS = 24 * 60 * 60 * 1000;

const EMOJI_ACTIONS = {
  "✅": { status: "done" as const },
  white_check_mark: { status: "done" as const },
  "👀": { status: "in_progress" as const },
  eyes: { status: "in_progress" as const },
  "🛑": { status: "canceled" as const },
  stop_sign: { status: "canceled" as const },
  "🔥": { priority: "urgent" as const },
  fire: { priority: "urgent" as const },
  "😴": { snooze: true },
  sleeping: { snooze: true },
} as const;

type EmojiKey = keyof typeof EMOJI_ACTIONS;

function slackMessageTs(raw: unknown): { channel?: string; ts?: string } {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const item =
    typeof record.item === "object" && record.item !== null
      ? (record.item as Record<string, unknown>)
      : record;
  const channel = typeof item.channel === "string" ? item.channel : undefined;
  const ts = typeof item.ts === "string" ? item.ts : undefined;
  return { channel, ts };
}

export function emojiToIssuePatch(
  emoji: string
): Partial<IssueInput> | undefined {
  if (!emoji || !Object.hasOwn(EMOJI_ACTIONS, emoji)) return undefined;
  const action = EMOJI_ACTIONS[emoji as EmojiKey];
  const patch: Partial<IssueInput> = {};
  if ("status" in action) patch.status = action.status;
  if ("priority" in action) patch.priority = action.priority;
  if ("snooze" in action) {
    patch.snoozedUntil = new Date(Date.now() + SNOOZE_MS).toISOString();
  }
  return patch;
}

export async function handleSlackReaction(
  env: WorkerEnv,
  db: D1Client,
  teamId: string,
  event: {
    added: boolean;
    emoji: { name?: string };
    messageId: string;
    raw: unknown;
  }
): Promise<void> {
  if (!event.added) return;

  const emojiName = event.emoji.name ?? "";
  const raw =
    typeof event.raw === "object" && event.raw !== null
      ? (event.raw as Record<string, unknown>)
      : {};
  const rawEmoji = typeof raw.reaction === "string" ? raw.reaction : undefined;
  const patch =
    emojiToIssuePatch(emojiName) ??
    (rawEmoji ? emojiToIssuePatch(rawEmoji) : undefined);
  if (!patch) return;

  const link = await slackOrgForTeam(db, teamId);
  if (!link) return;

  const { channel, ts } = slackMessageTs(event.raw);
  if (!channel) return;

  const conversation = await db
    .select()
    .from(supportConversations)
    .where(
      and(
        eq(supportConversations.organizationId, link.organizationId),
        eq(supportConversations.slackTeamId, teamId),
        eq(supportConversations.slackChannelId, channel),
        or(
          eq(supportConversations.slackThreadTs, ts ?? ""),
          eq(supportConversations.slackThreadTs, "")
        )
      )
    )
    .get();
  if (!conversation) return;

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(link.organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(link.organizationId);
  await stub.updateIssue(conversation.issueId, patch, undefined);
}

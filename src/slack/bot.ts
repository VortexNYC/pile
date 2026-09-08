import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { postSlackMessage } from "@chat-adapter/slack/api";
import { Chat } from "chat";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { D1StateAdapter } from "../global/chat-state.js";
import { createD1, type D1Client } from "../global/db.js";
import { slackInstallations } from "../global/schema.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AppEnv } from "../types/env.js";
import type { RealtimeEvent } from "../types/workspace.js";
import { workerdFetchAdapter } from "./fetch-adapter.js";

export function isSlackConfigured(env: AppEnv): boolean {
  return Boolean(
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET
  );
}

export function createSlack(env: AppEnv): SlackAdapter {
  return createSlackAdapter({
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingSecret: env.SLACK_SIGNING_SECRET,
    encryptionKey: env.SLACK_ENCRYPTION_KEY,
    webClientOptions: { adapter: workerdFetchAdapter },
  });
}

const slackTeamSchema = z.object({
  team_id: z.string().optional(),
  team: z.string().optional(),
});

function teamIdFromRaw(raw: unknown): string | undefined {
  const parsed = slackTeamSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.team_id ?? parsed.data.team;
}

export async function slackOrgForTeam(
  db: D1Client,
  teamId: string
): Promise<{ organizationId: string; teamId: string } | null> {
  const row = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .get();
  if (!row) return null;
  return { organizationId: row.organizationId, teamId: row.teamId };
}

async function createIssueFromText(
  env: WorkerEnv,
  organizationId: string,
  title: string,
  description?: string
): Promise<{ identifier: string | null; id: string } | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(organizationId);
  try {
    const issue = await stub.createIssue({ title: trimmed, description });
    return { identifier: issue.identifier ?? null, id: issue.id };
  } catch (error) {
    console.error("createIssue via DO failed", {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Build the Chat bot for one inbound webhook request. `teamId` is the Slack
 * workspace that sent the event (from the verified envelope), so mention and
 * slash-command handlers can resolve the owning Vortex workspace.
 */
export function createSlackBot(
  env: WorkerEnv,
  teamId?: string
): { bot: Chat<{ slack: SlackAdapter }>; slack: SlackAdapter } {
  const slack = createSlack(env);
  const bot = new Chat({
    userName: "vortex",
    adapters: { slack },
    state: new D1StateAdapter(env.D1),
  });

  const db = createD1(env.D1);
  const resolveOrg = async (raw: unknown) => {
    const team = teamIdFromRaw(raw) ?? teamId;
    if (!team) return null;
    return await slackOrgForTeam(db, team);
  };

  bot.onNewMention(async (thread, message) => {
    const text = message.text ?? "";
    const link = await resolveOrg(message.raw);
    if (!link) {
      await thread.post(
        "This Slack workspace isn't linked to a Vortex workspace yet. Install the app first."
      );
      return;
    }
    const title =
      text
        .replace(/<@[A-Z0-9]+>/g, "")
        .replace(/@[A-Z0-9]{8,}/g, "")
        .replace(/^@vortex\b(\s*\(local\))?/i, "")
        .trim() || "New issue";
    const issue = await createIssueFromText(env, link.organizationId, title);
    if (!issue) {
      await thread.post("Couldn't create an issue from that message.");
      return;
    }
    await thread.post(
      `Created issue ${issue.identifier ?? issue.id}: ${title}`
    );
  });

  bot.onSlashCommand("/vortex", async (event) => {
    const raw = event.raw;
    const link = await resolveOrg(raw);
    if (!link) {
      await event.channel.post(
        "This Slack workspace isn't linked to a Vortex workspace yet."
      );
      return;
    }
    const title = event.text.trim() || "New issue";
    const issue = await createIssueFromText(env, link.organizationId, title);
    if (!issue) {
      await event.channel.post("Couldn't create that issue.");
      return;
    }
    await event.channel.post(
      `Created issue ${issue.identifier ?? issue.id}: ${title}`
    );
  });

  return { bot, slack };
}

function slackEventText(event: RealtimeEvent): string | null {
  switch (event.type) {
    case "issue.created":
      return `:new: Issue ${event.issue.identifier ?? event.issue.id} created: *${event.issue.title}*`;
    case "issue.updated":
      return `:pencil2: Issue ${event.issue.identifier ?? event.issue.id} updated: *${event.issue.title}* (status: ${event.issue.status})`;
    case "issue.deleted":
      return `:wastebasket: Issue ${event.issueId} deleted`;
    case "comment.created":
      return `:speech_balloon: New comment on ${event.issue.identifier ?? event.issue.id}: ${event.comment.body.slice(0, 200)}`;
    case "comment.updated":
      return `:speech_balloon: Comment updated on ${event.issue.identifier ?? event.issue.id}`;
    case "comment.deleted":
      return `:speech_balloon: Comment deleted on issue ${event.issueId}`;
    default:
      return null;
  }
}

/**
 * Post a realtime event to the workspace's default Slack channel, if a Slack
 * installation with a configured channel exists for the organization.
 */
export async function notifySlack(
  env: AppEnv,
  organizationId: string,
  event: RealtimeEvent
): Promise<void> {
  if (!isSlackConfigured(env)) return;
  const text = slackEventText(event);
  if (text === null) return;

  const db = createD1(env.D1);
  const installation = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.organizationId, organizationId))
    .get();
  if (!installation?.defaultChannelId) return;

  const state = new D1StateAdapter(env.D1);
  const slack = createSlack(env);
  const bot = new Chat({ userName: "vortex", adapters: { slack }, state });
  await bot.initialize();

  const stored = await slack.getInstallation(installation.teamId);
  const botToken = stored?.botToken;
  if (!botToken) return;

  await postSlackMessage({
    token: botToken,
    channel: installation.defaultChannelId,
    text,
  });
}

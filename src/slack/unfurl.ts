import { z } from "zod";

import type { WorkerEnv } from "../platform/middleware.js";
import { createSlack } from "./bot.js";

const slackLinkSharedSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  event: z.object({
    type: z.literal("link_shared"),
    channel: z.string(),
    message_ts: z.string(),
    links: z.array(z.object({ url: z.string() })),
  }),
});

export type SlackLinkSharedPayload = z.infer<typeof slackLinkSharedSchema>;

export function isLinkSharedPayload(
  body: unknown
): body is SlackLinkSharedPayload {
  const result = slackLinkSharedSchema.safeParse(body);
  return result.success;
}

export function parsePileUrl(
  url: string
): { organizationId: string; identifier: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "pile.nyc") return null;
    const match = /^\/([^/]+)\/issues\/([^/]+)\/?$/.exec(u.pathname);
    if (!match) return null;
    return { organizationId: match[1], identifier: match[2] };
  } catch {
    return null;
  }
}

interface UnfurlIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export function buildUnfurlBlocks(
  url: string,
  issue: UnfurlIssue
): Record<string, { blocks: unknown[] }> {
  const issueUrl = `https://pile.nyc/${parsePileUrl(url)?.organizationId ?? ""}/issues/${issue.identifier ?? issue.id}`;
  const id = issue.identifier ?? issue.id;
  const title = issue.title || "Pile issue";
  return {
    [url]: {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<${issueUrl}|${id}: ${title}>*`,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Status*\n${issue.status}`,
            },
            {
              type: "mrkdwn",
              text: `*Priority*\n${issue.priority}`,
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View in Pile" },
              url: issueUrl,
            },
          ],
        },
      ],
    },
  };
}

export async function handleSlackUnfurl(
  env: WorkerEnv,
  payload: SlackLinkSharedPayload
): Promise<void> {
  const slack = createSlack(env);
  const stored = await slack.getInstallation(payload.team_id);
  const botToken = stored?.botToken;
  if (!botToken) return;

  const unfurls: Record<string, { blocks: unknown[] }> = {};

  for (const link of payload.event.links) {
    const parsed = parsePileUrl(link.url);
    if (!parsed) continue;

    const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(parsed.organizationId);
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
    await stub.setOrganizationId(parsed.organizationId);
    let issue = await stub.getIssueByIdentifier(parsed.identifier);
    if (!issue) {
      issue = await stub.getIssue(parsed.identifier);
    }
    if (!issue) continue;

    Object.assign(
      unfurls,
      buildUnfurlBlocks(link.url, {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
      })
    );
  }

  if (Object.keys(unfurls).length === 0) return;

  try {
    const res = await fetch("https://slack.com/api/chat.unfurl", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: payload.event.channel,
        ts: payload.event.message_ts,
        unfurls,
      }),
    });
    if (!res.ok) {
      console.error("chat.unfurl failed", {
        status: res.status,
        body: await res.text().catch(() => ""),
      });
    }
  } catch (error) {
    console.error("chat.unfurl error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

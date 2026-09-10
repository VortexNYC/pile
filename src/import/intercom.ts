import { z } from "zod";

import {
  createIntercomConversation,
  findIntercomConversation,
} from "../global/intercom-conversations.js";
import { VortexError } from "../platform/errors.js";
import type { IssueInput } from "../types/workspace.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

const INTERCOM_API_BASE = "https://api.intercom.io";
const INTERCOM_VERSION = "2.16";

export const intercomCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type IntercomCredentials = z.infer<typeof intercomCredentialsSchema>;

export const intercomOptionsSchema = z.object({
  teamId: z.string().optional(),
  state: z.enum(["open", "closed", "snoozed", "all"]).optional().default("all"),
  limit: z.number().int().min(1).max(1000).optional(),
});

export type IntercomOptions = z.infer<typeof intercomOptionsSchema>;

const intercomConversationSourceSchema = z.object({
  type: z.string(),
  subject: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
});

const intercomContactSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
});

const intercomAssigneeSchema = z
  .object({
    type: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional().nullable(),
  })
  .passthrough();

const intercomConversationSchema = z.object({
  type: z.literal("conversation"),
  id: z.string(),
  title: z.string().nullable().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  state: z.enum(["open", "closed", "snoozed"]).default("open"),
  priority: z
    .enum(["none", "low", "medium", "high", "urgent"])
    .optional()
    .default("none"),
  source: intercomConversationSourceSchema.nullable().default(null),
  assignee: intercomAssigneeSchema.optional().nullable(),
  contacts: z
    .object({
      type: z.string(),
      contacts: z.array(intercomContactSchema.passthrough()).default([]),
    })
    .optional(),
});

const intercomConversationListSchema = z.object({
  type: z.literal("conversation.list"),
  conversations: z.array(intercomConversationSchema),
  pages: z
    .object({
      next: z
        .object({
          starting_after: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
      per_page: z.number().int().optional(),
    })
    .nullable()
    .default(null),
});

type IntercomConversation = z.infer<typeof intercomConversationSchema>;

export async function intercomRequest(
  token: string,
  path: string
): Promise<unknown> {
  const response = await fetch(`${INTERCOM_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Intercom-Version": INTERCOM_VERSION,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VortexError({
      code: "BAD_REQUEST",
      status: response.status,
      message: `Intercom API request failed: ${response.statusText}${body ? ` — ${body}` : ""}`,
    });
  }
  return response.json();
}

function intercomStateToVortexStatus(
  state: IntercomConversation["state"]
): IssueInput["status"] {
  const map: Record<string, IssueInput["status"]> = {
    open: "triage",
    closed: "done",
    snoozed: "backlog",
  };
  return map[state] ?? "triage";
}

function intercomPriorityToVortexPriority(
  priority: IntercomConversation["priority"]
): IssueInput["priority"] {
  if (priority === "none") return "medium";
  return priority;
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function conversationTitle(conversation: IntercomConversation): string {
  if (conversation.title) return conversation.title;
  const subject = conversation.source?.subject;
  if (subject) return subject;
  const bodyPreview = stripHtml(conversation.source?.body).slice(0, 120);
  if (bodyPreview) return bodyPreview;
  return `Intercom conversation ${conversation.id}`;
}

function conversationBody(conversation: IntercomConversation): string {
  const body = conversation.source?.body ?? "";
  if (body) return body;
  const subject = conversation.source?.subject ?? "";
  if (subject) return `<p>${subject}</p>`;
  return "";
}

export async function listIntercomConversations(
  token: string,
  perPage: number,
  startingAfter?: string
): Promise<{
  conversations: IntercomConversation[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  params.set("per_page", String(perPage));
  if (startingAfter) {
    params.set("starting_after", startingAfter);
  }
  const raw = await intercomRequest(
    token,
    `/conversations?${params.toString()}`
  );
  const parsed = intercomConversationListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Intercom conversations response",
      hint: parsed.error.message,
    });
  }
  const next = parsed.data.pages?.next?.starting_after ?? null;
  return { conversations: parsed.data.conversations, nextCursor: next };
}

async function syncIntercomConversation(
  ctx: ImportContext,
  conversation: IntercomConversation,
  teamId: string | undefined,
  filterState: string
): Promise<"created" | "updated" | "skipped" | "error"> {
  if (filterState !== "all" && conversation.state !== filterState) {
    return "skipped";
  }

  const createdAt = new Date(conversation.created_at * 1000).toISOString();
  const updatedAt = new Date(conversation.updated_at * 1000).toISOString();

  try {
    const existing = await findIntercomConversation(
      ctx.db,
      ctx.organizationId,
      conversation.id
    );
    if (existing) {
      await ctx.stub.updateIssue(
        existing.issueId,
        {
          title: conversationTitle(conversation),
          description: conversationBody(conversation) || undefined,
          status: intercomStateToVortexStatus(conversation.state),
          priority: intercomPriorityToVortexPriority(conversation.priority),
          updatedAt,
        },
        ctx.importerId
      );
      return "updated";
    }

    const issue = await ctx.stub.createIssue(
      {
        title: conversationTitle(conversation),
        description: conversationBody(conversation) || undefined,
        status: intercomStateToVortexStatus(conversation.state),
        priority: intercomPriorityToVortexPriority(conversation.priority),
        teamId,
        createdAt,
        updatedAt,
      },
      ctx.importerId
    );
    await createIntercomConversation(
      ctx.db,
      ctx.organizationId,
      conversation.id,
      issue.id
    );
    return "created";
  } catch {
    return "error";
  }
}

export const intercomImportSource: ImportSource<
  IntercomCredentials,
  IntercomOptions
> = {
  name: "intercom",

  validate(credentials): ImportValidationResult {
    const parsed = intercomCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options, runState): Promise<ImportBatchResult> {
    const { token } = credentials;
    const parsedOptions = intercomOptionsSchema.parse(options ?? {});
    const { teamId, state: filterState } = parsedOptions;
    const perPage = 100;
    const limit = runState?.limit ?? parsedOptions.limit;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    const syncConversations = async (
      conversations: IntercomConversation[]
    ): Promise<void> => {
      if (conversations.length === 0) return;
      const [first, ...rest] = conversations;
      const result = await syncIntercomConversation(
        ctx,
        first,
        teamId,
        filterState
      );
      if (result === "created") created++;
      if (result === "updated") updated++;
      if (result === "skipped") skipped++;
      if (result === "error") errors++;
      return syncConversations(rest);
    };

    const processPage = async (cursor?: string): Promise<void> => {
      const { conversations, nextCursor: pageNext } =
        await listIntercomConversations(token, perPage, cursor);
      if (conversations.length === 0) {
        nextCursor = null;
        return;
      }

      await syncConversations(conversations);

      processed += conversations.length;

      const hasMore = pageNext !== null && pageNext !== undefined;
      const hitLimit = limit !== undefined && processed >= limit;
      if (!hasMore) {
        nextCursor = null;
        return;
      }
      if (hitLimit) {
        nextCursor = pageNext;
        return;
      }
      return processPage(pageNext ?? undefined);
    };

    await processPage(runState?.cursor ?? parsedOptions.cursor ?? undefined);

    return {
      counts: {
        issues: created + updated,
        created,
        updated,
        skipped,
        errors,
      },
      nextCursor: nextCursor ?? undefined,
    };
  },
};

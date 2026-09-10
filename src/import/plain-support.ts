import { z } from "zod";

import { recordImportMapping } from "../global/import-mappings.js";
import {
  createCustomer,
  findCustomerByExternalId,
} from "../global/support-contacts.js";
import type {
  ExternalSupportAttachment,
  ExternalSupportEvent,
  ExternalSupportReply,
  SupportTicketActorType,
  SupportTicketEventType,
  SupportTicketMessageChannel,
} from "../global/support-tickets.js";
import { createTicketFromPlain } from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

const PLAIN_API_BASE = "https://core-api.uk.plain.com/graphql/v1";

export const plainSupportCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type PlainSupportCredentials = z.infer<
  typeof plainSupportCredentialsSchema
>;

export const plainSupportOptionsSchema = z.object({
  state: z.enum(["todo", "done", "snoozed", "all"]).optional().default("all"),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
});

export type PlainSupportOptions = z.infer<typeof plainSupportOptionsSchema>;

async function plainRequest(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operationName: string
): Promise<unknown> {
  const response = await fetch(PLAIN_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables, operationName }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VortexError({
      code: "BAD_REQUEST",
      status: response.status,
      message: `Plain API request failed: ${response.statusText}${body ? ` — ${body}` : ""}`,
    });
  }

  const raw = (await response.json()) as {
    errors?: { message: string }[];
    data?: unknown;
  };
  if (raw.errors && raw.errors.length > 0) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: `Plain GraphQL error: ${raw.errors[0].message}`,
    });
  }
  return raw.data;
}

const plainTimestampSchema = z.object({
  iso8601: z.string(),
});

const plainCustomerSchema = z.object({
  id: z.string(),
  fullName: z.string().optional().nullable(),
  email: z
    .object({
      email: z.string(),
    })
    .optional()
    .nullable(),
});

const plainThreadSchema = z.object({
  id: z.string(),
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  status: z.string(),
  priority: z.string().optional().nullable(),
  createdAt: plainTimestampSchema.optional().nullable(),
  updatedAt: plainTimestampSchema.optional().nullable(),
  customer: plainCustomerSchema.optional().nullable(),
});

const plainPageInfoSchema = z.object({
  endCursor: z.string().optional().nullable(),
  hasNextPage: z.boolean(),
});

const plainThreadsResponseSchema = z.object({
  threads: z.object({
    nodes: z.array(plainThreadSchema),
    pageInfo: plainPageInfoSchema,
  }),
});

type PlainThread = z.infer<typeof plainThreadSchema>;

function plainStatusToVortex(status: string): "todo" | "done" | "snoozed" {
  const normalized = status.toLowerCase();
  if (normalized === "done" || normalized === "closed") return "done";
  if (normalized === "snoozed") return "snoozed";
  return "todo";
}

function plainPriorityToVortex(
  priority: string | null | undefined
): "none" | "low" | "medium" | "high" | "urgent" {
  if (!priority) return "none";
  const normalized = priority.toLowerCase();
  if (normalized === "normal") return "medium";
  if (
    normalized === "none" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "urgent"
  ) {
    return normalized;
  }
  return "none";
}

function customerEmail(customer: { email?: { email: string } | null }): string {
  if (customer.email?.email) return customer.email.email;
  return `${customer.id}@plain.imported`;
}

async function getOrCreatePlainSupportCustomer(
  ctx: ImportContext,
  customer: {
    id: string;
    fullName?: string | null;
    email?: { email: string } | null;
  }
): Promise<string> {
  const existing = await findCustomerByExternalId(
    ctx.db,
    ctx.organizationId,
    customer.id,
    "plain"
  );
  if (existing) {
    return existing.id;
  }

  const created = await createCustomer(ctx.db, {
    organizationId: ctx.organizationId,
    email: customerEmail(customer),
    fullName: customer.fullName ?? null,
    externalId: customer.id,
    externalSource: "plain",
  });
  return created.id;
}

async function listPlainThreads(
  token: string,
  first: number,
  after?: string
): Promise<{
  threads: PlainThread[];
  nextCursor: string | null;
}> {
  const query = `
    query SupportThreads($first: Int, $after: String) {
      threads(first: $first, after: $after) {
        nodes {
          id
          title
          description
          status
          priority
          createdAt { iso8601 }
          updatedAt { iso8601 }
          customer {
            id
            fullName
            email { email }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  `;

  const data = await plainRequest(
    token,
    query,
    {
      first,
      after: after ?? null,
    },
    "SupportThreads"
  );
  const parsed = plainThreadsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Plain threads response",
      hint: parsed.error.message,
    });
  }

  const { threads } = parsed.data;
  const nextCursor = threads.pageInfo.hasNextPage
    ? (threads.pageInfo.endCursor ?? null)
    : null;
  return { threads: threads.nodes, nextCursor };
}

const plainAttachmentSchema = z
  .object({
    id: z.string(),
    fileName: z.string().optional().nullable(),
    fileExtension: z.string().optional().nullable(),
    fileMimeType: z.string().optional().nullable(),
    fileSize: z
      .object({
        bytes: z.number(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

const plainActorSchema = z
  .object({
    customerId: z.string().optional().nullable(),
    userId: z.string().optional().nullable(),
    machineUserId: z.string().optional().nullable(),
    systemId: z.string().optional().nullable(),
    customer: z.object({ id: z.string() }).passthrough().optional().nullable(),
    user: z.object({ id: z.string() }).passthrough().optional().nullable(),
    machineUser: z
      .object({ id: z.string() })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

const plainEntrySchema = z
  .object({
    typename: z.string(),
  })
  .passthrough();

const plainTimelineEntrySchema = z.object({
  id: z.string(),
  timestamp: plainTimestampSchema,
  llmText: z.string().optional().nullable(),
  actor: plainActorSchema.optional().nullable(),
  entry: plainEntrySchema,
});

type PlainTimelineEntry = z.infer<typeof plainTimelineEntrySchema>;

const plainTimelineResponseSchema = z.object({
  thread: z.object({
    timelineEntries: z.object({
      nodes: z.array(plainTimelineEntrySchema),
      pageInfo: plainPageInfoSchema,
    }),
  }),
});

function entryString(
  entry: PlainTimelineEntry["entry"],
  key: string
): string | null {
  const value = entry[key];
  return typeof value === "string" ? value : null;
}

function componentTexts(components: unknown): string[] {
  if (!Array.isArray(components)) {
    return [];
  }
  return components
    .map((component) => {
      if (
        typeof component === "object" &&
        component !== null &&
        "text" in component &&
        typeof component.text === "string"
      ) {
        return component.text;
      }
      return null;
    })
    .filter((text): text is string => text !== null);
}

function timelineBody(
  entry: PlainTimelineEntry["entry"],
  llmText: string | null | undefined
): string {
  const direct =
    entryString(entry, "text") ??
    entryString(entry, "markdown") ??
    entryString(entry, "markdownContent") ??
    entryString(entry, "resolvedText") ??
    entryString(entry, "fullTextContent") ??
    entryString(entry, "textContent");
  if (direct) {
    return direct;
  }

  const title = entryString(entry, "title");
  const components = componentTexts(entry.components);
  const joined = [title, ...components]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0
    )
    .join("\n");
  if (joined) {
    return joined;
  }

  return llmText ?? "";
}

function timelineActor(entry: PlainTimelineEntry): {
  actorType: SupportTicketActorType;
  actorId: string | null;
} {
  const actor = entry.actor;
  if (!actor) {
    return { actorType: "system", actorId: null };
  }
  const customerId = actor.customerId ?? actor.customer?.id ?? null;
  if (customerId) {
    return { actorType: "customer", actorId: customerId };
  }
  const userId = actor.userId ?? actor.user?.id ?? null;
  if (userId) {
    return { actorType: "user", actorId: userId };
  }
  const machineUserId = actor.machineUserId ?? actor.machineUser?.id ?? null;
  if (machineUserId) {
    return { actorType: "machine", actorId: machineUserId };
  }
  if (actor.systemId) {
    return { actorType: "system", actorId: actor.systemId };
  }
  return { actorType: "system", actorId: null };
}

function timelineDirection(entry: PlainTimelineEntry): "inbound" | "outbound" {
  const actor = entry.actor;
  if (!actor) {
    return "outbound";
  }
  if (actor.customerId != null || actor.customer != null) {
    return "inbound";
  }
  return "outbound";
}

function timelineChannel(
  entry: PlainTimelineEntry["entry"]
): SupportTicketMessageChannel {
  const typename = entry.typename;
  if (typename === "EmailEntry") {
    return "email";
  }
  if (typename === "SlackMessageEntry" || typename === "SlackReplyEntry") {
    return "slack";
  }
  if (typename === "MSTeamsMessageEntry") {
    return "msteams";
  }
  if (typename === "DiscordMessageEntry") {
    return "discord";
  }
  return "chat";
}

function timelineAttachments(
  entry: PlainTimelineEntry["entry"]
): ExternalSupportAttachment[] {
  const parsed = z.array(plainAttachmentSchema).safeParse(entry.attachments);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.map((attachment) => ({
    externalId: attachment.id,
    fileName: attachment.fileName ?? null,
    contentType: attachment.fileMimeType ?? null,
    size: attachment.fileSize?.bytes ?? null,
  }));
}

function entryLabelDiffs(entry: PlainTimelineEntry["entry"]): {
  added: string[];
  removed: string[];
} {
  const schema = z.object({
    previousLabels: z
      .array(z.object({ id: z.string() }))
      .optional()
      .nullable(),
    nextLabels: z
      .array(z.object({ id: z.string() }))
      .optional()
      .nullable(),
  });
  const parsed = schema.safeParse(entry);
  if (!parsed.success) {
    return { added: [], removed: [] };
  }
  const previousIds = new Set(
    (parsed.data.previousLabels ?? []).map((label) => label.id)
  );
  const nextIds = new Set(
    (parsed.data.nextLabels ?? []).map((label) => label.id)
  );
  const added = [...nextIds].filter((id) => !previousIds.has(id));
  const removed = [...previousIds].filter((id) => !nextIds.has(id));
  return { added, removed };
}

function entryEventType(
  entry: PlainTimelineEntry["entry"]
): SupportTicketEventType {
  const typename = entry.typename;
  if (typename === "ThreadStatusTransitionedEntry") {
    return "status_change";
  }
  if (typename === "ThreadPriorityChangedEntry") {
    return "priority_change";
  }
  if (
    typename === "ThreadAssignmentTransitionedEntry" ||
    typename === "ThreadAdditionalAssigneesTransitionedEntry"
  ) {
    return "assignment_change";
  }
  if (typename === "ThreadLabelsChangedEntry") {
    return "label_added";
  }
  if (
    typename === "CustomerEventEntry" ||
    typename === "CustomerSurveyRequestedEntry"
  ) {
    return typename === "CustomerSurveyRequestedEntry"
      ? "survey_requested"
      : "customer_event";
  }
  if (
    typename === "ThreadServiceLevelAgreementPolicyChangedEntry" ||
    typename === "ServiceLevelAgreementStatusTransitionedEntry"
  ) {
    return "sla_change";
  }
  if (
    typename === "ThreadLinkCreatedEntry" ||
    typename === "ThreadLinkTargetCreatedEntry"
  ) {
    return "link_added";
  }
  if (typename === "ThreadLinkUpdatedEntry") {
    return "link_changed";
  }
  if (
    typename === "ThreadLinkDeletedEntry" ||
    typename === "ThreadLinkTargetDeletedEntry"
  ) {
    return "link_removed";
  }
  if (typename === "ThreadDiscussionEntry") {
    return "discussion";
  }
  if (typename === "ThreadDiscussionResolvedEntry") {
    return "discussion_resolved";
  }
  if (typename === "ThreadEventEntry") {
    return "thread_event";
  }
  if (typename === "CustomEntry") {
    return "custom_entry";
  }
  if (typename === "LinearIssueThreadLinkStateTransitionedEntry") {
    return "external_reference_changed";
  }
  return "field_change";
}

const PLAIN_TIMELINE_ENTRY_FRAGMENT = `
  typename: __typename
  ... on ChatEntry { chatId text attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on NoteEntry { noteId text markdown attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on EmailEntry { emailId subject textContent fullTextContent attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on CustomEntry { title type components { __typename ... on ComponentText { text } } attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on SlackMessageEntry { text attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on SlackReplyEntry { text attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on MSTeamsMessageEntry { text markdownContent attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on DiscordMessageEntry { markdownContent attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on ThreadDiscussionMessageEntry { text resolvedText attachments { id fileName fileExtension fileMimeType fileSize { bytes } } }
  ... on HelpCenterAiConversationMessageEntry { markdown }
  ... on MergedThreadMessageEntry { threadLinkId childThreadDetails { id title } }
  ... on ThreadStatusTransitionedEntry { previousStatus nextStatus }
  ... on ThreadPriorityChangedEntry { previousPriority nextPriority }
  ... on ThreadAssignmentTransitionedEntry { previousAssignee { __typename ... on User { id } ... on MachineUser { id } ... on System { systemId } } nextAssignee { __typename ... on User { id } ... on MachineUser { id } ... on System { systemId } } }
  ... on ThreadAdditionalAssigneesTransitionedEntry { previousAssignees { __typename ... on User { id } ... on MachineUser { id } ... on System { systemId } } nextAssignees { __typename ... on User { id } ... on MachineUser { id } ... on System { systemId } } }
  ... on ThreadLabelsChangedEntry { previousLabels { id name } nextLabels { id name } }
  ... on ThreadServiceLevelAgreementPolicyChangedEntry { previousServiceLevelAgreementPolicy { id name } nextServiceLevelAgreementPolicy { id name } }
  ... on ServiceLevelAgreementStatusTransitionedEntry { previousStatus nextStatus }
  ... on ThreadEventEntry { title components { __typename ... on ComponentText { text } } }
  ... on CustomerEventEntry { title components { __typename ... on ComponentText { text } } }
  ... on LinearIssueThreadLinkStateTransitionedEntry { previousLinearStateId nextLinearStateId }
  ... on ThreadLinkCreatedEntry { threadLink { id title } }
  ... on ThreadLinkUpdatedEntry { threadLink { id title } previousThreadLink { id title } }
  ... on ThreadLinkDeletedEntry { threadLink { id title } }
  ... on ThreadLinkTargetCreatedEntry { threadLink { id title } sourceThread { id title } }
  ... on ThreadLinkTargetDeletedEntry { threadLink { id title } sourceThread { id title } }
  ... on CustomerSurveyRequestedEntry { customerSurveyId surveyResponseId surveyResponsePublicId }
  ... on ThreadDiscussionEntry { threadDiscussionId discussionType emailRecipients slackChannelName slackMessageLink }
  ... on ThreadDiscussionResolvedEntry { threadDiscussionId discussionType emailRecipients slackChannelName slackMessageLink resolvedAt }
`;

async function getPlainThreadTimeline(
  token: string,
  threadId: string,
  after?: string
): Promise<{
  replies: ExternalSupportReply[];
  events: ExternalSupportEvent[];
}> {
  const query = `
    query ThreadTimeline($threadId: ID!, $first: Int, $after: String) {
      thread(threadId: $threadId) {
        timelineEntries(first: $first, after: $after) {
          nodes {
            id
            timestamp { iso8601 }
            llmText
            actor {
              ... on CustomerActor { customerId }
              ... on DeletedCustomerActor { customerId }
              ... on UserActor { userId }
              ... on SystemActor { systemId }
              ... on MachineUserActor { machineUserId }
            }
            entry {
              ${PLAIN_TIMELINE_ENTRY_FRAGMENT}
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  `;

  const data = await plainRequest(
    token,
    query,
    {
      threadId,
      first: 100,
      after: after ?? null,
    },
    "ThreadTimeline"
  );
  const parsed = plainTimelineResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Plain thread timeline response",
      hint: parsed.error.message,
    });
  }

  const nodes = parsed.data.thread.timelineEntries.nodes;
  const pageInfo = parsed.data.thread.timelineEntries.pageInfo;

  const replies: ExternalSupportReply[] = [];
  const events: ExternalSupportEvent[] = [];
  const messageTypes = new Set([
    "ChatEntry",
    "EmailEntry",
    "SlackMessageEntry",
    "SlackReplyEntry",
    "MSTeamsMessageEntry",
    "DiscordMessageEntry",
    "ThreadDiscussionMessageEntry",
    "MergedThreadMessageEntry",
    "HelpCenterAiConversationMessageEntry",
  ]);

  for (const node of nodes) {
    const { actorType, actorId } = timelineActor(node);
    const createdAt = node.timestamp.iso8601;
    const body = timelineBody(node.entry, node.llmText);
    const attachments = timelineAttachments(node.entry);
    const typename = node.entry.typename;
    const metadata = {
      llmText: node.llmText,
      entry: node.entry,
    };

    if (typename === "NoteEntry") {
      replies.push({
        body,
        direction: timelineDirection(node),
        kind: "note",
        actorType,
        actorId,
        subType: typename,
        attachments,
        createdAt,
        metadata,
      });
      continue;
    }

    if (messageTypes.has(typename)) {
      replies.push({
        body,
        direction: timelineDirection(node),
        kind: "message",
        channel: timelineChannel(node.entry),
        actorType,
        actorId,
        subType: typename,
        attachments,
        createdAt,
        metadata,
      });
      continue;
    }

    if (typename === "ThreadLabelsChangedEntry") {
      const { added, removed } = entryLabelDiffs(node.entry);
      const labelEvents: ExternalSupportEvent[] = [];
      for (const labelId of added) {
        labelEvents.push({
          type: "label_added",
          subType: typename,
          actorType,
          actorId,
          createdAt,
          metadata: { ...metadata, labelId },
        });
      }
      for (const labelId of removed) {
        labelEvents.push({
          type: "label_removed",
          subType: typename,
          actorType,
          actorId,
          createdAt,
          metadata: { ...metadata, labelId },
        });
      }
      if (labelEvents.length === 0) {
        events.push({
          type: "field_change",
          subType: typename,
          actorType,
          actorId,
          createdAt,
          metadata,
        });
      } else {
        events.push(...labelEvents);
      }
      continue;
    }

    events.push({
      type: entryEventType(node.entry),
      subType: typename,
      actorType,
      actorId,
      createdAt,
      metadata,
    });
  }

  if (pageInfo.hasNextPage && pageInfo.endCursor) {
    const next = await getPlainThreadTimeline(
      token,
      threadId,
      pageInfo.endCursor
    );
    return {
      replies: [...replies, ...next.replies],
      events: [...events, ...next.events],
    };
  }

  return { replies, events };
}

export const plainSupportImportSource: ImportSource<
  PlainSupportCredentials,
  PlainSupportOptions
> = {
  name: "plain-support",

  validate(credentials): ImportValidationResult {
    const parsed = plainSupportCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options, runState): Promise<ImportBatchResult> {
    const { token } = credentials;
    const parsedOptions = plainSupportOptionsSchema.parse(options ?? {});
    const { state: filterState } = parsedOptions;
    const pageSize = 100;
    const limit = runState?.limit ?? parsedOptions.limit;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    const processPage = async (cursor?: string): Promise<void> => {
      const { threads, nextCursor: pageNext } = await listPlainThreads(
        token,
        pageSize,
        cursor
      );
      if (threads.length === 0) {
        nextCursor = null;
        return;
      }

      await Promise.all(
        threads.map(async (thread) => {
          try {
            const status = plainStatusToVortex(thread.status);
            if (filterState !== "all" && status !== filterState) {
              skipped++;
              return;
            }

            const customer = thread.customer;
            if (!customer) {
              errors++;
              return;
            }

            const [customerId, timeline] = await Promise.all([
              getOrCreatePlainSupportCustomer(ctx, customer),
              getPlainThreadTimeline(token, thread.id),
            ]);

            const firstReply = timeline.replies[0];
            const source = {
              type: "plain",
              body: firstReply?.body ?? thread.description,
            };
            const replies = firstReply
              ? timeline.replies.slice(1)
              : timeline.replies;

            const result = await createTicketFromPlain(
              ctx.db,
              ctx.organizationId,
              customerId,
              {
                id: thread.id,
                title: thread.title,
                status,
                priority: plainPriorityToVortex(thread.priority),
                source,
                createdAt: thread.createdAt?.iso8601,
                updatedAt: thread.updatedAt?.iso8601,
                replies,
                events: timeline.events,
              },
              {}
            );

            await recordImportMapping(
              ctx.db,
              ctx.organizationId,
              ctx.jobId,
              "plain-support",
              "ticket",
              thread.id,
              result.id
            );

            const isExisting =
              result.externalId === thread.id &&
              result.createdAt !== thread.createdAt?.iso8601;
            if (isExisting) {
              updated++;
            } else {
              created++;
            }
          } catch {
            errors++;
          }
        })
      );

      processed += threads.length;

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
      return processPage(pageNext);
    };

    await processPage(runState?.cursor ?? parsedOptions.cursor ?? undefined);

    return {
      counts: {
        tickets: created + updated,
        created,
        updated,
        skipped,
        errors,
      },
      nextCursor: nextCursor ?? undefined,
    };
  },
};

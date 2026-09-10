import { z } from "zod";

import { recordImportMapping } from "../global/import-mappings.js";
import {
  createCustomer,
  findCustomerByExternalId,
} from "../global/support-contacts.js";
import type { ExternalSupportReply } from "../global/support-tickets.js";
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
  variables: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(PLAIN_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables, operationName: "SupportThreads" }),
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

  const data = await plainRequest(token, query, {
    first,
    after: after ?? null,
  });
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

const plainActorSchema = z
  .object({
    customer: z.object({ id: z.string() }).passthrough().optional().nullable(),
    user: z.object({ id: z.string() }).passthrough().optional().nullable(),
    machineUser: z
      .object({ id: z.string() })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

const plainTimelineEntrySchema = z.object({
  id: z.string(),
  timestamp: plainTimestampSchema,
  actor: plainActorSchema.optional().nullable(),
  entry: z
    .object({
      chatId: z.string().optional().nullable(),
      text: z.string().optional().nullable(),
      title: z.string().optional().nullable(),
      components: z
        .array(
          z
            .object({
              text: z.string().optional().nullable(),
            })
            .passthrough()
        )
        .optional()
        .nullable(),
    })
    .passthrough(),
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

function timelineBody(entry: PlainTimelineEntry["entry"]): string {
  if (entry.chatId) return entry.text ?? "";
  if (entry.title) {
    const parts = [
      entry.title,
      ...(entry.components ?? []).map((component) => component.text),
    ];
    return parts
      .filter(
        (text): text is string => typeof text === "string" && text.length > 0
      )
      .join("\n");
  }
  return "";
}

function timelineDirection(entry: PlainTimelineEntry): "inbound" | "outbound" {
  return entry.actor?.customer != null ? "inbound" : "outbound";
}

async function getPlainThreadTimeline(
  token: string,
  threadId: string,
  after?: string
): Promise<ExternalSupportReply[]> {
  const query = `
    query ThreadTimeline($threadId: ID!, $first: Int, $after: String) {
      thread(threadId: $threadId) {
        timelineEntries(first: $first, after: $after) {
          nodes {
            id
            timestamp { iso8601 }
            actor {
              customer { id }
              user { id }
              machineUser { id }
            }
            entry {
              ... on ChatEntry { chatId text }
              ... on CustomEntry { title components { ... on ComponentText { text } } }
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

  const data = await plainRequest(token, query, {
    threadId,
    first: 100,
    after: after ?? null,
  });
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
  const mapped = nodes.map((node) => ({
    body: timelineBody(node),
    direction: timelineDirection(node),
    customerId: null,
    userId: null,
    createdAt: node.timestamp.iso8601,
  }));

  if (pageInfo.hasNextPage && pageInfo.endCursor) {
    const next = await getPlainThreadTimeline(
      token,
      threadId,
      pageInfo.endCursor
    );
    return [...mapped, ...next];
  }

  return mapped;
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
    let after: string | undefined =
      runState?.cursor ?? parsedOptions.cursor ?? undefined;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    while (true) {
      const { threads, nextCursor: pageNext } = await listPlainThreads(
        token,
        pageSize,
        after
      );
      if (threads.length === 0) break;

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

            const firstEntry = timeline[0];
            const source = {
              type: "plain",
              body: firstEntry?.body ?? thread.description,
            };
            const replies = firstEntry ? timeline.slice(1) : timeline;

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
      nextCursor = pageNext;
      after = pageNext ?? undefined;

      const hasMore = nextCursor !== null && nextCursor !== undefined;
      const hitLimit = limit !== undefined && processed >= limit;
      if (!hasMore || hitLimit) {
        if (hasMore && hitLimit) {
          nextCursor = nextCursor as string | null;
        } else if (!hasMore) {
          nextCursor = null;
        }
        break;
      }
    }

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

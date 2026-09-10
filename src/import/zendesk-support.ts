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
  SupportTicketMessageChannel,
} from "../global/support-tickets.js";
import { createTicketFromZendesk } from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

export const zendeskSupportCredentialsSchema = z.object({
  subdomain: z.string().min(1),
  email: z.string().email(),
  token: z.string().min(1),
});

export type ZendeskSupportCredentials = z.infer<
  typeof zendeskSupportCredentialsSchema
>;

export const zendeskSupportOptionsSchema = z.object({
  state: z
    .enum(["open", "pending", "hold", "solved", "closed", "all"])
    .optional()
    .default("all"),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
});

export type ZendeskSupportOptions = z.infer<typeof zendeskSupportOptionsSchema>;

type ZendeskCredentials = {
  subdomain: string;
  email: string;
  token: string;
};

function zendeskAuthHeader(credentials: ZendeskCredentials): string {
  const encoded = btoa(`${credentials.email}/token:${credentials.token}`);
  return `Basic ${encoded}`;
}

async function zendeskRequest(
  credentials: ZendeskCredentials,
  path: string
): Promise<unknown> {
  const url = `https://${credentials.subdomain}.zendesk.com${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: zendeskAuthHeader(credentials),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VortexError({
      code: "BAD_REQUEST",
      status: response.status,
      message: `Zendesk API request failed: ${response.statusText}${body ? ` — ${body}` : ""}`,
    });
  }
  return response.json();
}

const zendeskUserSchema = z
  .object({
    id: z.number().int(),
    email: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

const zendeskTicketSchema = z
  .object({
    id: z.number().int(),
    subject: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    status: z.enum(["open", "pending", "hold", "solved", "closed"]),
    priority: z
      .enum(["urgent", "high", "normal", "low"])
      .optional()
      .default("normal"),
    requester_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

const zendeskTicketListSchema = z.object({
  tickets: z.array(zendeskTicketSchema),
  users: z.array(zendeskUserSchema).optional().default([]),
  meta: z
    .object({
      has_more: z.boolean(),
      after_cursor: z.string().optional(),
    })
    .optional()
    .default({ has_more: false }),
});

const zendeskAttachmentSchema = z
  .object({
    id: z.number().int(),
    file_name: z.string().optional().nullable(),
    content_url: z.string().optional().nullable(),
    content_type: z.string().optional().nullable(),
    size: z.number().optional().nullable(),
  })
  .passthrough();

const zendeskCommentSchema = z
  .object({
    id: z.number().int(),
    body: z.string().optional().nullable(),
    html_body: z.string().optional().nullable(),
    public: z.boolean().optional(),
    author_id: z.number().int(),
    created_at: z.string(),
    via: z
      .object({
        channel: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    attachments: z.array(zendeskAttachmentSchema).optional().default([]),
  })
  .passthrough();

const zendeskCommentListSchema = z.object({
  comments: z.array(zendeskCommentSchema),
  users: z.array(zendeskUserSchema).optional().default([]),
});

type ZendeskTicket = z.infer<typeof zendeskTicketSchema>;
type ZendeskUser = z.infer<typeof zendeskUserSchema>;

async function listZendeskTickets(
  credentials: ZendeskCredentials,
  perPage: number,
  afterCursor?: string
): Promise<{
  tickets: ZendeskTicket[];
  users: ZendeskUser[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  params.set("page[size]", String(perPage));
  params.set("include", "users");
  if (afterCursor) {
    params.set("page[after]", afterCursor);
  }

  const raw = await zendeskRequest(
    credentials,
    `/api/v2/tickets.json?${params.toString()}`
  );
  const parsed = zendeskTicketListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Zendesk tickets response",
      hint: parsed.error.message,
    });
  }

  const { tickets, users, meta } = parsed.data;
  const nextCursor = meta?.has_more ? (meta?.after_cursor ?? null) : null;
  return { tickets, users, nextCursor };
}

function userById(
  users: ZendeskUser[],
  id: number
): { id: number; email?: string; name?: string } | null {
  return users.find((user) => user.id === id) ?? null;
}

function requesterEmail(requester: { id: number; email?: string }): string {
  if (requester.email) return requester.email;
  return `${requester.id}@zendesk.imported`;
}

async function getOrCreateZendeskSupportCustomer(
  ctx: ImportContext,
  requester: { id: number; email?: string; name?: string }
): Promise<string> {
  const existing = await findCustomerByExternalId(
    ctx.db,
    ctx.organizationId,
    String(requester.id),
    "zendesk"
  );
  if (existing) {
    return existing.id;
  }

  const customer = await createCustomer(ctx.db, {
    organizationId: ctx.organizationId,
    email: requesterEmail(requester),
    fullName: requester.name ?? null,
    externalId: String(requester.id),
    externalSource: "zendesk",
  });
  return customer.id;
}

function commentActor(
  comment: z.infer<typeof zendeskCommentSchema>,
  ticket: ZendeskTicket,
  users: ZendeskUser[]
): { actorType: SupportTicketActorType; actorId: string | null } {
  if (comment.author_id === ticket.requester_id) {
    return { actorType: "customer", actorId: String(comment.author_id) };
  }
  const author = userById(users, comment.author_id);
  const role = author?.role?.toLowerCase() ?? "";
  if (role === "system") {
    return { actorType: "system", actorId: String(comment.author_id) };
  }
  if (role === "agent" || role === "admin") {
    return { actorType: "user", actorId: String(comment.author_id) };
  }
  if (role === "end-user") {
    return { actorType: "customer", actorId: String(comment.author_id) };
  }
  return { actorType: "user", actorId: String(comment.author_id) };
}

function commentChannel(
  comment: z.infer<typeof zendeskCommentSchema>
): SupportTicketMessageChannel {
  const channel = comment.via?.channel?.toLowerCase() ?? "";
  if (
    channel === "email" ||
    channel === "chat" ||
    channel === "api" ||
    channel === "slack" ||
    channel === "msteams" ||
    channel === "discord"
  ) {
    return channel;
  }
  return "email";
}

async function getZendeskTicketComments(
  credentials: ZendeskCredentials,
  ticket: ZendeskTicket
): Promise<ExternalSupportReply[]> {
  const raw = await zendeskRequest(
    credentials,
    `/api/v2/tickets/${ticket.id}/comments.json?include=users`
  );
  const parsed = zendeskCommentListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Zendesk comments response",
      hint: parsed.error.message,
    });
  }

  const sorted = parsed.data.comments.toSorted(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  );

  return sorted.map((comment) => {
    const { actorType, actorId } = commentActor(
      comment,
      ticket,
      parsed.data.users ?? []
    );
    const attachments: ExternalSupportAttachment[] = comment.attachments.map(
      (attachment) => ({
        externalId: String(attachment.id),
        url: attachment.content_url,
        fileName: attachment.file_name ?? null,
        contentType: attachment.content_type ?? null,
        size: attachment.size ?? null,
      })
    );

    return {
      body: comment.html_body ?? comment.body ?? "(no content)",
      direction: actorType === "customer" ? "inbound" : "outbound",
      kind: comment.public === false ? "note" : "message",
      channel: commentChannel(comment),
      actorType,
      actorId,
      createdAt: comment.created_at,
      attachments,
      metadata: { comment },
    };
  });
}

export const zendeskSupportImportSource: ImportSource<
  ZendeskSupportCredentials,
  ZendeskSupportOptions
> = {
  name: "zendesk-support",

  validate(credentials): ImportValidationResult {
    const parsed = zendeskSupportCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options, runState): Promise<ImportBatchResult> {
    const parsedOptions = zendeskSupportOptionsSchema.parse(options ?? {});
    const { state: filterState } = parsedOptions;
    const perPage = 100;
    const limit = runState?.limit ?? parsedOptions.limit;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    const processPage = async (cursor?: string): Promise<void> => {
      const {
        tickets,
        users,
        nextCursor: pageNext,
      } = await listZendeskTickets(credentials, perPage, cursor);
      if (tickets.length === 0) {
        nextCursor = null;
        return;
      }

      await Promise.all(
        tickets.map(async (ticket) => {
          try {
            if (filterState !== "all" && ticket.status !== filterState) {
              skipped++;
              return;
            }

            const requester = userById(users, ticket.requester_id);
            if (!requester) {
              errors++;
              return;
            }

            const [customerId, replies] = await Promise.all([
              getOrCreateZendeskSupportCustomer(ctx, requester),
              getZendeskTicketComments(credentials, ticket),
            ]);

            const ticketEvent: ExternalSupportEvent = {
              type: "field_change",
              actorType: "system",
              actorId: null,
              createdAt: ticket.created_at,
              metadata: { ticket },
            };

            const result = await createTicketFromZendesk(
              ctx.db,
              ctx.organizationId,
              customerId,
              {
                id: String(ticket.id),
                subject: ticket.subject,
                description: ticket.description,
                status: ticket.status,
                priority: ticket.priority,
                source: {},
                createdAt: ticket.created_at,
                updatedAt: ticket.updated_at,
                replies,
                events: [ticketEvent],
              },
              {}
            );

            await recordImportMapping(
              ctx.db,
              ctx.organizationId,
              ctx.jobId,
              "zendesk-support",
              "ticket",
              String(ticket.id),
              result.id
            );

            const isExisting =
              result.externalId === String(ticket.id) &&
              result.createdAt !== ticket.created_at;
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

      processed += tickets.length;

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

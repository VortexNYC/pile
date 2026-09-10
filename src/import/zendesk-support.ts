import { z } from "zod";

import {
  createCustomer,
  findCustomerByExternalId,
} from "../global/support-contacts.js";
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
    let afterCursor: string | undefined =
      runState?.cursor ?? parsedOptions.cursor ?? undefined;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    while (true) {
      const {
        tickets,
        users,
        nextCursor: pageNext,
      } = await listZendeskTickets(credentials, perPage, afterCursor);
      if (tickets.length === 0) break;

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

            const customerId = await getOrCreateZendeskSupportCustomer(
              ctx,
              requester
            );

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
                replies: [],
              },
              {}
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
      nextCursor = pageNext;
      afterCursor = pageNext ?? undefined;

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

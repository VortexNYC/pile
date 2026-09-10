import { z } from "zod";

import { recordImportMapping } from "../global/import-mappings.js";
import {
  createCustomer,
  findCustomerByExternalId,
} from "../global/support-contacts.js";
import type { ExternalSupportReply } from "../global/support-tickets.js";
import { createTicketFromIntercom } from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import {
  intercomCredentialsSchema,
  intercomOptionsSchema,
  intercomRequest,
  listIntercomConversations,
} from "./intercom.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

export const intercomSupportCredentialsSchema = intercomCredentialsSchema;
export type IntercomSupportCredentials = z.infer<
  typeof intercomSupportCredentialsSchema
>;

export const intercomSupportOptionsSchema = intercomOptionsSchema;
export type IntercomSupportOptions = z.infer<
  typeof intercomSupportOptionsSchema
>;

function contactEmail(contact: { id: string; email?: string }): string {
  if (contact.email) return contact.email;
  return `${contact.id}@intercom.imported`;
}

async function getOrCreateIntercomSupportCustomer(
  ctx: ImportContext,
  contact: { id: string; email?: string; name?: string }
): Promise<string> {
  const existing = await findCustomerByExternalId(
    ctx.db,
    ctx.organizationId,
    contact.id,
    "intercom"
  );
  if (existing) {
    return existing.id;
  }

  const customer = await createCustomer(ctx.db, {
    organizationId: ctx.organizationId,
    email: contactEmail(contact),
    fullName: contact.name ?? null,
    externalId: contact.id,
    externalSource: "intercom",
  });
  return customer.id;
}

const intercomAuthorSchema = z
  .object({
    id: z.string(),
    type: z.string(),
  })
  .passthrough();

const intercomConversationPartSchema = z
  .object({
    id: z.string(),
    part_type: z.string(),
    body: z.string().nullable().default(null),
    created_at: z.number().int(),
    author: intercomAuthorSchema.optional().nullable(),
  })
  .passthrough();

const intercomConversationDetailSchema = z
  .object({
    type: z.literal("conversation"),
    id: z.string(),
    conversation_parts: z
      .object({
        type: z.literal("conversation_part.list"),
        conversation_parts: z.array(intercomConversationPartSchema).default([]),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

type IntercomConversationPart = z.infer<typeof intercomConversationPartSchema>;

function partDirection(part: IntercomConversationPart): "inbound" | "outbound" {
  const authorType = part.author?.type?.toLowerCase() ?? "";
  if (
    authorType === "user" ||
    authorType === "lead" ||
    authorType === "contact"
  ) {
    return "inbound";
  }
  return "outbound";
}

async function getIntercomConversationParts(
  token: string,
  conversationId: string
): Promise<ExternalSupportReply[]> {
  const raw = await intercomRequest(
    token,
    `/conversations/${conversationId}?include=conversation_parts`
  );
  const parsed = intercomConversationDetailSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Intercom conversation response",
      hint: parsed.error.message,
    });
  }

  const parts = parsed.data.conversation_parts?.conversation_parts ?? [];
  const messages = parts.filter(
    (part) => part.part_type === "comment" || part.part_type === "note"
  );
  const sorted = messages.toSorted((a, b) => a.created_at - b.created_at);

  return sorted.map((part) => ({
    body: part.body ?? "(no content)",
    direction: partDirection(part),
    customerId: null,
    userId: null,
    createdAt: new Date(part.created_at * 1000).toISOString(),
  }));
}

export const intercomSupportImportSource: ImportSource<
  IntercomSupportCredentials,
  IntercomSupportOptions
> = {
  name: "intercom-support",

  validate(credentials): ImportValidationResult {
    const parsed = intercomSupportCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options, runState): Promise<ImportBatchResult> {
    const { token } = credentials;
    const parsedOptions = intercomSupportOptionsSchema.parse(options ?? {});
    const { state: filterState } = parsedOptions;
    const perPage = 100;
    const limit = runState?.limit ?? parsedOptions.limit;
    let startingAfter: string | undefined =
      runState?.cursor ?? parsedOptions.cursor ?? undefined;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    while (true) {
      const { conversations, nextCursor: pageNext } =
        await listIntercomConversations(token, perPage, startingAfter);
      if (conversations.length === 0) break;

      await Promise.all(
        conversations.map(async (conversation) => {
          try {
            if (filterState !== "all" && conversation.state !== filterState) {
              skipped++;
              return;
            }

            const contacts = conversation.contacts?.contacts ?? [];
            const primary = contacts[0];
            if (!primary) {
              errors++;
              return;
            }

            const [customerId, replies] = await Promise.all([
              getOrCreateIntercomSupportCustomer(
                ctx,
                primary as { id: string; email?: string; name?: string }
              ),
              getIntercomConversationParts(token, conversation.id),
            ]);

            const result = await createTicketFromIntercom(
              ctx.db,
              ctx.organizationId,
              customerId,
              {
                id: conversation.id,
                title: conversation.title,
                state: conversation.state,
                priority: conversation.priority,
                source: conversation.source ?? {},
                created_at: conversation.created_at,
                updated_at: conversation.updated_at,
                replies,
              },
              {}
            );

            await recordImportMapping(
              ctx.db,
              ctx.organizationId,
              ctx.jobId,
              "intercom-support",
              "ticket",
              conversation.id,
              result.id
            );

            const isExisting =
              result.externalId === conversation.id &&
              result.createdAt !==
                new Date(conversation.created_at * 1000).toISOString();
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

      processed += conversations.length;
      nextCursor = pageNext;
      startingAfter = pageNext ?? undefined;

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

import { z } from "zod";

import {
  createCustomer,
  findCustomerByExternalId,
} from "../global/support-contacts.js";
import { createTicketFromIntercom } from "../global/support-tickets.js";
import {
  intercomCredentialsSchema,
  intercomOptionsSchema,
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

            const customerId = await getOrCreateIntercomSupportCustomer(
              ctx,
              primary as { id: string; email?: string; name?: string }
            );

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
                replies: [],
              },
              {}
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

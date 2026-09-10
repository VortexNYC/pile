import { z } from "zod";

import { recordImportMapping } from "../global/import-mappings.js";
import {
  createCustomer,
  findCustomerByExternalId,
  findOrCreateCompany,
  setCustomerCompanies,
  setCustomerIdentities,
  type CustomerIdentityInput,
} from "../global/support-contacts.js";
import type {
  ExternalSupportAttachment,
  ExternalSupportEvent,
  ExternalSupportReply,
  SupportTicketActorType,
  SupportTicketEventType,
} from "../global/support-tickets.js";
import {
  createTicketFromIntercom,
  findUserByEmail,
  setTicketAssignees,
} from "../global/support-tickets.js";
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

const intercomSocialProfileSchema = z
  .object({
    type: z.string(),
    username: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
  })
  .passthrough();

const intercomCompanySchema = z
  .object({
    type: z.string().optional(),
    id: z.string(),
    company_id: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    website: z.string().optional().nullable(),
  })
  .passthrough();

const intercomContactDetailSchema = z
  .object({
    type: z.literal("contact"),
    id: z.string(),
    email: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    external_id: z.string().optional().nullable(),
    custom_attributes: z.record(z.unknown()).optional(),
    companies: z.array(intercomCompanySchema).optional().default([]),
    social_profiles: z
      .array(intercomSocialProfileSchema)
      .optional()
      .default([]),
  })
  .passthrough();

async function getIntercomContactDetail(
  token: string,
  contactId: string
): Promise<z.infer<typeof intercomContactDetailSchema> | null> {
  const raw = await intercomRequest(token, `/contacts/${contactId}`);
  const parsed = intercomContactDetailSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

function intercomSocialProfileToInput(
  profile: z.infer<typeof intercomSocialProfileSchema>
): CustomerIdentityInput | null {
  const type = profile.type.toLowerCase();
  const value = profile.username ?? profile.url ?? "";
  if (!value) return null;
  if (
    type === "twitter" ||
    type === "facebook" ||
    type === "linkedin" ||
    type === "instagram"
  ) {
    return { type: "social", subType: type, value, isPrimary: false };
  }
  return { type: "custom", subType: profile.type, value, isPrimary: false };
}

async function getOrCreateIntercomSupportCustomer(
  ctx: ImportContext,
  token: string,
  contact: { id: string; email?: string; name?: string }
): Promise<string> {
  const existing = await findCustomerByExternalId(
    ctx.db,
    ctx.organizationId,
    contact.id,
    "intercom"
  );
  const customerId = existing
    ? existing.id
    : (
        await createCustomer(ctx.db, {
          organizationId: ctx.organizationId,
          email: contactEmail(contact),
          fullName: contact.name ?? null,
          externalId: contact.id,
          externalSource: "intercom",
        })
      ).id;

  const detail = await getIntercomContactDetail(token, contact.id);
  if (!detail) return customerId;

  const companyInputs = (detail.companies ?? []).map((company) => ({
    name: company.name ?? "Unknown company",
    domain: company.website ?? null,
    externalId: company.company_id ?? company.id,
    externalSource: "intercom" as const,
  }));

  const companies = await Promise.all(
    companyInputs.map(async (input) => {
      const company = await findOrCreateCompany(
        ctx.db,
        ctx.organizationId,
        input
      );
      return { companyId: company.id, isPrimary: false };
    })
  );

  if (companies.length > 0) {
    await setCustomerCompanies(
      ctx.db,
      ctx.organizationId,
      customerId,
      companies
    );
  }

  const identities: CustomerIdentityInput[] = [];
  if (detail.email) {
    identities.push({
      type: "email",
      subType: "email",
      value: detail.email,
      isPrimary: true,
    });
  }
  if (detail.phone) {
    identities.push({
      type: "phone",
      subType: "phone",
      value: detail.phone,
      isPrimary: false,
    });
  }
  for (const profile of detail.social_profiles ?? []) {
    const input = intercomSocialProfileToInput(profile);
    if (input) identities.push(input);
  }
  if (identities.length > 0) {
    await setCustomerIdentities(
      ctx.db,
      ctx.organizationId,
      customerId,
      identities
    );
  }

  return customerId;
}

const intercomAttachmentSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    url: z.string(),
    content_type: z.string().nullable().optional(),
    filesize: z.number().nullable().optional(),
  })
  .passthrough();

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
    attachments: z.array(intercomAttachmentSchema).default([]),
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

function partActor(part: IntercomConversationPart): {
  actorType: SupportTicketActorType;
  actorId: string | null;
} {
  const authorType = part.author?.type?.toLowerCase() ?? "";
  if (
    authorType === "user" ||
    authorType === "lead" ||
    authorType === "contact"
  ) {
    return { actorType: "customer", actorId: part.author?.id ?? null };
  }
  if (authorType === "admin" || authorType === "team") {
    return { actorType: "user", actorId: part.author?.id ?? null };
  }
  if (
    authorType === "bot" ||
    authorType === "fin" ||
    authorType === "copilot"
  ) {
    return { actorType: "machine", actorId: part.author?.id ?? null };
  }
  if (authorType === "system") {
    return { actorType: "system", actorId: part.author?.id ?? null };
  }
  return { actorType: "user", actorId: part.author?.id ?? null };
}

const intercomMessagePartTypes = new Set([
  "comment",
  "note",
  "whatsapp",
  "linked_message",
]);

const intercomCustomPartTypes = new Set(["custom_bot", "custom_card"]);

function partEventType(part: IntercomConversationPart): SupportTicketEventType {
  const partType = part.part_type.toLowerCase();
  if (
    partType === "open" ||
    partType === "close" ||
    partType === "snoozed" ||
    partType === "waiting"
  ) {
    return "status_change";
  }
  if (
    partType === "assigned" ||
    partType === "unassigned" ||
    partType === "assignment"
  ) {
    return "assignment_change";
  }
  if (
    partType === "conversation_rating" ||
    partType === "rating" ||
    partType === "survey" ||
    partType === "csat" ||
    partType === "nps"
  ) {
    return "survey_received";
  }
  if (partType === "feedback") {
    return "customer_event";
  }
  if (intercomCustomPartTypes.has(partType)) {
    return "custom_entry";
  }
  if (partType === "follow_up" || partType === "push_notification") {
    return "notification";
  }
  if (intercomMessagePartTypes.has(partType)) {
    return "notification";
  }
  if (
    partType === "source_add" ||
    partType === "ticket_shared" ||
    partType === "automation_flywheel" ||
    partType === "log_event" ||
    partType === "default"
  ) {
    return "thread_event";
  }
  return "field_change";
}

function partAttachments(
  part: IntercomConversationPart
): ExternalSupportAttachment[] {
  return part.attachments.map((attachment) => ({
    externalId: attachment.id,
    url: attachment.url,
    fileName: attachment.name ?? null,
    contentType: attachment.content_type ?? null,
    size: attachment.filesize ?? null,
  }));
}

async function getIntercomConversationParts(
  token: string,
  conversationId: string
): Promise<{
  replies: ExternalSupportReply[];
  events: ExternalSupportEvent[];
}> {
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
  const sorted = parts.toSorted((a, b) => a.created_at - b.created_at);

  const replies: ExternalSupportReply[] = [];
  const events: ExternalSupportEvent[] = [];

  for (const part of sorted) {
    const { actorType, actorId } = partActor(part);
    const createdAt = new Date(part.created_at * 1000).toISOString();
    const attachments = partAttachments(part);
    const partType = part.part_type.toLowerCase();
    const metadata = {
      partType: part.part_type,
      body: part.body,
      author: part.author,
      attachments: part.attachments,
      part,
    };

    const isReply =
      intercomMessagePartTypes.has(partType) &&
      part.body !== null &&
      part.body !== undefined &&
      part.body.length > 0 &&
      !intercomCustomPartTypes.has(partType);

    if (isReply) {
      replies.push({
        body: part.body ?? "(no content)",
        direction: partDirection(part),
        kind: partType === "note" ? "note" : "message",
        actorType,
        actorId,
        subType: part.part_type,
        createdAt,
        attachments,
        metadata,
      });
      continue;
    }

    events.push({
      type: partEventType(part),
      subType: part.part_type,
      actorType,
      actorId,
      createdAt,
      metadata,
    });
  }

  return { replies, events };
}

async function syncIntercomTicketAssignees(
  ctx: ImportContext,
  ticketId: string,
  assignee: { type?: string; email?: string | null } | null | undefined
): Promise<void> {
  if (!assignee || assignee.type !== "admin" || !assignee.email) {
    return;
  }
  const user = await findUserByEmail(ctx.db, assignee.email);
  if (!user) {
    return;
  }
  await setTicketAssignees(ctx.db, ctx.organizationId, ticketId, [
    { userId: user.id, isPrimary: true },
  ]);
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

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    let nextCursor: string | null = null;

    const processPage = async (cursor?: string): Promise<void> => {
      const { conversations, nextCursor: pageNext } =
        await listIntercomConversations(token, perPage, cursor);
      if (conversations.length === 0) {
        nextCursor = null;
        return;
      }

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

            const [customerId, timeline] = await Promise.all([
              getOrCreateIntercomSupportCustomer(
                ctx,
                token,
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
                replies: timeline.replies,
                events: timeline.events,
              },
              {}
            );

            await Promise.all([
              syncIntercomTicketAssignees(
                ctx,
                result.id,
                conversation.assignee
              ),
              recordImportMapping(
                ctx.db,
                ctx.organizationId,
                ctx.jobId,
                "intercom-support",
                "ticket",
                conversation.id,
                result.id
              ),
            ]);

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

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
  SupportTicketMessageChannel,
} from "../global/support-tickets.js";
import {
  createTicketFromZendesk,
  findOrCreateTeam,
  findUserByEmail,
  setTicketAssignees,
  type SupportTicketAssigneeInput,
} from "../global/support-tickets.js";
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
  pathOrUrl: string
): Promise<unknown> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${credentials.subdomain}.zendesk.com${pathOrUrl}`;
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
    phone: z.string().optional().nullable(),
    organization_id: z.number().int().optional().nullable(),
  })
  .passthrough();

const zendeskOrganizationSchema = z
  .object({
    id: z.number().int(),
    name: z.string().optional().nullable(),
    domain_names: z.array(z.string()).optional().default([]),
    external_id: z.string().optional().nullable(),
  })
  .passthrough();

const zendeskOrganizationListSchema = z.object({
  organizations: z.array(zendeskOrganizationSchema),
  meta: z
    .object({
      has_more: z.boolean(),
      after_cursor: z.string().optional(),
    })
    .optional()
    .default({ has_more: false }),
});

const zendeskGroupSchema = z
  .object({
    id: z.number().int(),
    name: z.string().optional().nullable(),
  })
  .passthrough();

const zendeskGroupListSchema = z.object({
  groups: z.array(zendeskGroupSchema),
  meta: z
    .object({
      has_more: z.boolean(),
      after_cursor: z.string().optional(),
    })
    .optional()
    .default({ has_more: false }),
});

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
    assignee_id: z.number().int().optional().nullable(),
    group_id: z.number().int().optional().nullable(),
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

const zendeskAuditEventSchema = z
  .object({
    id: z.number().int().optional(),
    type: z.string(),
    field_name: z.string().optional().nullable(),
    value: z.unknown().optional(),
    previous_value: z.unknown().optional(),
    body: z.string().optional().nullable(),
    html_body: z.string().optional().nullable(),
    public: z.boolean().optional().nullable(),
    attachments: z.array(zendeskAttachmentSchema).optional().default([]),
    via: z
      .object({
        channel: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    recipients: z.array(z.number()).optional().nullable(),
  })
  .passthrough();

const zendeskAuditSchema = z
  .object({
    id: z.number().int(),
    ticket_id: z.number().int(),
    created_at: z.string(),
    author_id: z.number().int(),
    events: z.array(zendeskAuditEventSchema).optional().default([]),
  })
  .passthrough();

const zendeskAuditListSchema = z.object({
  audits: z.array(zendeskAuditSchema),
  next_page: z.string().optional().nullable(),
  previous_page: z.string().optional().nullable(),
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

type ZendeskOrganization = z.infer<typeof zendeskOrganizationSchema>;

async function listAllZendeskOrganizations(
  credentials: ZendeskCredentials
): Promise<Map<number, ZendeskOrganization>> {
  const organizations = new Map<number, ZendeskOrganization>();

  const fetchPage = async (cursor?: string): Promise<void> => {
    const params = new URLSearchParams();
    params.set("page[size]", "100");
    if (cursor) {
      params.set("page[after]", cursor);
    }

    const raw = await zendeskRequest(
      credentials,
      `/api/v2/organizations.json?${params.toString()}`
    );
    const parsed = zendeskOrganizationListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 500,
        message: "Invalid Zendesk organizations response",
        hint: parsed.error.message,
      });
    }

    for (const org of parsed.data.organizations) {
      organizations.set(org.id, org);
    }

    const meta = parsed.data.meta;
    if (meta?.has_more && meta.after_cursor) {
      await fetchPage(meta.after_cursor);
    }
  };

  await fetchPage();
  return organizations;
}

type ZendeskGroup = z.infer<typeof zendeskGroupSchema>;

async function listAllZendeskGroups(
  credentials: ZendeskCredentials
): Promise<Map<number, ZendeskGroup>> {
  const groups = new Map<number, ZendeskGroup>();

  const fetchPage = async (cursor?: string): Promise<void> => {
    const params = new URLSearchParams();
    params.set("page[size]", "100");
    if (cursor) {
      params.set("page[after]", cursor);
    }

    const raw = await zendeskRequest(
      credentials,
      `/api/v2/groups.json?${params.toString()}`
    );
    const parsed = zendeskGroupListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 500,
        message: "Invalid Zendesk groups response",
        hint: parsed.error.message,
      });
    }

    for (const group of parsed.data.groups) {
      groups.set(group.id, group);
    }

    const meta = parsed.data.meta;
    if (meta?.has_more && meta.after_cursor) {
      await fetchPage(meta.after_cursor);
    }
  };

  await fetchPage();
  return groups;
}

function userById(users: ZendeskUser[], id: number): ZendeskUser | null {
  return users.find((user) => user.id === id) ?? null;
}

function requesterEmail(requester: { id: number; email?: string }): string {
  if (requester.email) return requester.email;
  return `${requester.id}@zendesk.imported`;
}

async function getOrCreateZendeskSupportCustomer(
  ctx: ImportContext,
  requester: ZendeskUser,
  organizations: Map<number, ZendeskOrganization>
): Promise<string> {
  const existing = await findCustomerByExternalId(
    ctx.db,
    ctx.organizationId,
    String(requester.id),
    "zendesk"
  );
  const customerId = existing
    ? existing.id
    : (
        await createCustomer(ctx.db, {
          organizationId: ctx.organizationId,
          email: requesterEmail(requester),
          fullName: requester.name ?? null,
          externalId: String(requester.id),
          externalSource: "zendesk",
        })
      ).id;

  const companies: { companyId: string; isPrimary: boolean }[] = [];
  const org = requester.organization_id
    ? organizations.get(requester.organization_id)
    : null;
  if (org) {
    const domain = org.domain_names?.[0] ?? null;
    const company = await findOrCreateCompany(ctx.db, ctx.organizationId, {
      name: org.name ?? "Unknown organization",
      domain,
      externalId: org.external_id ?? String(org.id),
      externalSource: "zendesk",
    });
    companies.push({ companyId: company.id, isPrimary: true });
    await setCustomerCompanies(
      ctx.db,
      ctx.organizationId,
      customerId,
      companies
    );
  }

  const identities: CustomerIdentityInput[] = [];
  if (requester.email) {
    identities.push({
      type: "email",
      subType: "email",
      value: requester.email,
      isPrimary: true,
    });
  }
  if (requester.phone) {
    identities.push({
      type: "phone",
      subType: "phone",
      value: requester.phone,
      isPrimary: false,
    });
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

async function syncZendeskTicketAssignees(
  ctx: ImportContext,
  ticketId: string,
  ticket: ZendeskTicket,
  users: ZendeskUser[],
  groups: Map<number, ZendeskGroup>
): Promise<void> {
  const assignees: SupportTicketAssigneeInput[] = [];

  if (ticket.assignee_id) {
    const assignee = userById(users, ticket.assignee_id);
    if (assignee?.email) {
      const user = await findUserByEmail(ctx.db, assignee.email);
      if (user) {
        assignees.push({ userId: user.id, isPrimary: true });
      }
    }
  }

  if (ticket.group_id) {
    const group = groups.get(ticket.group_id);
    if (group?.name) {
      const team = await findOrCreateTeam(
        ctx.db,
        ctx.organizationId,
        group.name,
        ctx.importerId
      );
      assignees.push({
        teamId: team.id,
        isPrimary: assignees.length === 0,
      });
    }
  }

  if (assignees.length > 0) {
    await setTicketAssignees(ctx.db, ctx.organizationId, ticketId, assignees);
  }
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
    return { actorType: "automation", actorId: String(comment.author_id) };
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
): Promise<{ replies: ExternalSupportReply[]; users: ZendeskUser[] }> {
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

  const users = parsed.data.users ?? [];
  const sorted = parsed.data.comments.toSorted(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  );

  const replies = sorted.map((comment) => {
    const { actorType, actorId } = commentActor(comment, ticket, users);
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
      subType: comment.public === false ? "InternalComment" : "Comment",
      createdAt: comment.created_at,
      attachments,
      metadata: { comment },
    };
  });

  return { replies, users };
}

function auditActor(
  audit: z.infer<typeof zendeskAuditSchema>,
  ticket: ZendeskTicket,
  users: ZendeskUser[]
): { actorType: SupportTicketActorType; actorId: string | null } {
  if (audit.author_id === ticket.requester_id) {
    return { actorType: "customer", actorId: String(audit.author_id) };
  }
  const author = userById(users, audit.author_id);
  const role = author?.role?.toLowerCase() ?? "";
  if (role === "system") {
    return { actorType: "automation", actorId: String(audit.author_id) };
  }
  if (role === "agent" || role === "admin") {
    return { actorType: "user", actorId: String(audit.author_id) };
  }
  if (role === "end-user") {
    return { actorType: "customer", actorId: String(audit.author_id) };
  }
  return { actorType: "user", actorId: String(audit.author_id) };
}

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return null;
}

function auditTagEvents(
  audit: z.infer<typeof zendeskAuditSchema>,
  event: z.infer<typeof zendeskAuditEventSchema>,
  actorType: SupportTicketActorType,
  actorId: string | null,
  subType: string
): ExternalSupportEvent[] {
  const previous = parseStringArray(event.previous_value) ?? [];
  const next = parseStringArray(event.value) ?? [];
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const added = [...nextSet].filter((tag) => !previousSet.has(tag));
  const removed = [...previousSet].filter((tag) => !nextSet.has(tag));

  const events: ExternalSupportEvent[] = [];
  for (const tag of added) {
    events.push({
      type: "label_added",
      subType,
      actorType,
      actorId,
      createdAt: audit.created_at,
      metadata: { audit, event, tag },
    });
  }
  for (const tag of removed) {
    events.push({
      type: "label_removed",
      subType,
      actorType,
      actorId,
      createdAt: audit.created_at,
      metadata: { audit, event, tag },
    });
  }
  if (events.length === 0) {
    events.push({
      type: "field_change",
      subType,
      actorType,
      actorId,
      createdAt: audit.created_at,
      metadata: { audit, event },
    });
  }
  return events;
}

function mapZendeskAuditEvent(
  audit: z.infer<typeof zendeskAuditSchema>,
  event: z.infer<typeof zendeskAuditEventSchema>,
  actorType: SupportTicketActorType,
  actorId: string | null
): ExternalSupportEvent[] {
  const createdAt = audit.created_at;
  const metadata = { audit, event };

  if (event.type === "Comment" || event.type === "VoiceComment") {
    return [];
  }

  if (event.type === "Change" && event.field_name) {
    const fieldName = event.field_name;
    const subType = `Change:${fieldName}`;

    switch (fieldName) {
      case "status":
        return [
          {
            type: "status_change",
            subType,
            actorType,
            actorId,
            createdAt,
            metadata,
          },
        ];
      case "priority":
        return [
          {
            type: "priority_change",
            subType,
            actorType,
            actorId,
            createdAt,
            metadata,
          },
        ];
      case "assignee_id":
      case "group_id":
        return [
          {
            type: "assignment_change",
            subType,
            actorType,
            actorId,
            createdAt,
            metadata,
          },
        ];
      case "tags":
        return auditTagEvents(audit, event, actorType, actorId, subType);
      default:
        return [
          {
            type: "field_change",
            subType,
            actorType,
            actorId,
            createdAt,
            metadata,
          },
        ];
    }
  }

  switch (event.type) {
    case "SatisfactionRating":
      return [
        {
          type: "survey_received",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    case "Notification":
    case "NotificationWithCcs":
    case "ForwardingEvent":
      return [
        {
          type: "notification",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    case "Cc":
    case "FollowersCc":
    case "FollowerChangeAction":
      return [
        {
          type: "watchers_changed",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    case "VoiceComment":
      return [
        {
          type: "call",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    case "ProblemSolvedEvent":
    case "ProblemsSolvedEvent":
      return [
        {
          type: "status_change",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    case "Create":
    case "AgentWorkspaceSwitch":
    case "ExternalEvent":
    case "ChannelFrameworkEvent":
    case "AgentMacroReference":
    case "OrganizationActivity":
    case "Error":
    case "CommentPrivacyChange":
      return [
        {
          type: "thread_event",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
    default:
      return [
        {
          type: "field_change",
          subType: event.type,
          actorType,
          actorId,
          createdAt,
          metadata,
        },
      ];
  }
}

async function getZendeskTicketAudits(
  credentials: ZendeskCredentials,
  ticket: ZendeskTicket,
  users: ZendeskUser[],
  pathOrUrl: string = `/api/v2/tickets/${ticket.id}/audits.json?limit=100`
): Promise<ExternalSupportEvent[]> {
  const raw = await zendeskRequest(credentials, pathOrUrl);
  const parsed = zendeskAuditListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Zendesk audits response",
      hint: parsed.error.message,
    });
  }

  const events: ExternalSupportEvent[] = [];
  for (const audit of parsed.data.audits) {
    const { actorType, actorId } = auditActor(audit, ticket, users);
    for (const event of audit.events ?? []) {
      const mapped = mapZendeskAuditEvent(audit, event, actorType, actorId);
      events.push(...mapped);
    }
  }

  const nextPage = parsed.data.next_page;
  if (nextPage) {
    const nextUrl = new URL(nextPage);
    const nextPath = `${nextUrl.pathname}${nextUrl.search}`;
    const rest = await getZendeskTicketAudits(
      credentials,
      ticket,
      users,
      nextPath
    );
    return [...events, ...rest];
  }

  return events;
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

    const organizations = await listAllZendeskOrganizations(credentials);
    const groups = await listAllZendeskGroups(credentials);

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

            const [customerId, comments] = await Promise.all([
              getOrCreateZendeskSupportCustomer(ctx, requester, organizations),
              getZendeskTicketComments(credentials, ticket),
            ]);

            const allUsers = Array.from(
              new Map(
                [...users, ...comments.users].map((u) => [u.id, u])
              ).values()
            );

            const auditEvents = await getZendeskTicketAudits(
              credentials,
              ticket,
              allUsers
            );

            const ticketEvent: ExternalSupportEvent = {
              type: "field_change",
              actorType: "automation",
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
                replies: comments.replies,
                events: [ticketEvent, ...auditEvents],
              },
              {}
            );

            await syncZendeskTicketAssignees(
              ctx,
              result.id,
              ticket,
              allUsers,
              groups
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

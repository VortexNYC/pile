import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import type { D1Client } from "./db.js";
import {
  supportEscalationRules,
  supportTicketEvents,
  supportTickets,
} from "./schema.js";
import type { SupportCustomer } from "./support-contacts.js";
import {
  type SupportTicket,
  type SupportTicketChannel,
  type SupportTicketMessageChannel,
  type SupportTicketPriority,
  type SupportTicketSource,
  type SupportTicketStatus,
} from "./support-tickets.js";
import { safeJSON } from "./team-metadata.js";

export const SUPPORT_TICKET_STATUSES = [
  "todo",
  "done",
  "snoozed",
] as const satisfies SupportTicketStatus[];

export const SUPPORT_TICKET_PRIORITIES = [
  "low",
  "medium",
  "high",
  "urgent",
] as const satisfies SupportTicketPriority[];

export const SUPPORT_TICKET_SOURCES = [
  "intercom",
  "zendesk",
  "plain",
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "api",
  "manual",
] as const satisfies SupportTicketSource[];

export const SUPPORT_TICKET_CHANNELS = [
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "capture",
  "api",
  "intercom",
  "zendesk",
  "plain",
] as const satisfies SupportTicketChannel[];

export const escalationConditionsSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  channels: z.array(z.enum(SUPPORT_TICKET_CHANNELS)).optional(),
  priorities: z.array(z.enum(SUPPORT_TICKET_PRIORITIES)).optional(),
  statuses: z.array(z.enum(SUPPORT_TICKET_STATUSES)).optional(),
  sources: z.array(z.enum(SUPPORT_TICKET_SOURCES)).optional(),
  customerDomains: z.array(z.string()).optional(),
});

export type EscalationConditions = z.infer<typeof escalationConditionsSchema>;

export const escalationActionSchema = z.object({
  type: z.literal("create_issue"),
  teamId: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"] as const).optional(),
  status: z
    .enum([
      "triage",
      "backlog",
      "todo",
      "in_progress",
      "done",
      "canceled",
    ] as const)
    .optional(),
  labelIds: z.array(z.string()).optional(),
});

export type EscalationAction = z.infer<typeof escalationActionSchema>;

export type SupportEscalationRuleInput = {
  organizationId: string;
  name: string;
  isActive?: boolean;
  sortOrder?: number;
  conditions: EscalationConditions;
  action: EscalationAction;
};

export type SupportEscalationRule = {
  id: string;
  organizationId: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  conditions: string;
  action: string;
  createdAt: string;
  updatedAt: string;
};

export function serializeEscalationRuleConditions(
  conditions: EscalationConditions
): string {
  return JSON.stringify(escalationConditionsSchema.parse(conditions));
}

export function parseEscalationRuleConditions(
  raw: string
): EscalationConditions {
  const parsed = safeJSON(raw);
  const result = escalationConditionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid escalation conditions: ${result.error.message}`);
  }
  return result.data;
}

export function serializeEscalationRuleAction(
  action: EscalationAction
): string {
  return JSON.stringify(escalationActionSchema.parse(action));
}

export function parseEscalationRuleAction(raw: string): EscalationAction {
  const parsed = safeJSON(raw);
  const result = escalationActionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid escalation action: ${result.error.message}`);
  }
  return result.data;
}

export async function getActiveEscalationRules(
  db: D1Client,
  organizationId: string
): Promise<SupportEscalationRule[]> {
  return db
    .select()
    .from(supportEscalationRules)
    .where(
      and(
        eq(supportEscalationRules.organizationId, organizationId),
        eq(supportEscalationRules.isActive, true)
      )
    )
    .orderBy(
      asc(supportEscalationRules.sortOrder),
      asc(supportEscalationRules.createdAt)
    );
}

export type EscalationContext = {
  text: string;
  subject?: string;
  customer?: SupportCustomer | null;
  source?: SupportTicketSource;
  channel?: SupportTicketMessageChannel;
};

function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const parts = email.split("@");
  return parts[1]?.toLowerCase() ?? null;
}

function containsKeyword(keyword: string, haystack: string): boolean {
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}

export async function createEscalationRule(
  db: D1Client,
  input: SupportEscalationRuleInput
): Promise<SupportEscalationRule> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    organizationId: input.organizationId,
    name: input.name,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    conditions: serializeEscalationRuleConditions(input.conditions),
    action: serializeEscalationRuleAction(input.action),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(supportEscalationRules).values(row);
  return row;
}

export async function getEscalationRuleById(
  db: D1Client,
  organizationId: string,
  ruleId: string
): Promise<SupportEscalationRule | null> {
  const [row] = await db
    .select()
    .from(supportEscalationRules)
    .where(
      and(
        eq(supportEscalationRules.id, ruleId),
        eq(supportEscalationRules.organizationId, organizationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listEscalationRules(
  db: D1Client,
  organizationId: string
): Promise<SupportEscalationRule[]> {
  return db
    .select()
    .from(supportEscalationRules)
    .where(eq(supportEscalationRules.organizationId, organizationId))
    .orderBy(
      asc(supportEscalationRules.sortOrder),
      asc(supportEscalationRules.createdAt)
    );
}

type UpdateEscalationRuleInput = {
  name?: string;
  isActive?: boolean;
  sortOrder?: number;
  conditions?: EscalationConditions;
  action?: EscalationAction;
};

export async function updateEscalationRule(
  db: D1Client,
  organizationId: string,
  ruleId: string,
  input: UpdateEscalationRuleInput
): Promise<SupportEscalationRule | null> {
  const existing = await getEscalationRuleById(db, organizationId, ruleId);
  if (!existing) return null;

  const updates: Partial<typeof supportEscalationRules.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
  if (input.conditions !== undefined) {
    updates.conditions = serializeEscalationRuleConditions(input.conditions);
  }
  if (input.action !== undefined) {
    updates.action = serializeEscalationRuleAction(input.action);
  }

  await db
    .update(supportEscalationRules)
    .set(updates)
    .where(
      and(
        eq(supportEscalationRules.id, ruleId),
        eq(supportEscalationRules.organizationId, organizationId)
      )
    );

  return getEscalationRuleById(db, organizationId, ruleId);
}

export async function deleteEscalationRule(
  db: D1Client,
  organizationId: string,
  ruleId: string
): Promise<boolean> {
  const existing = await getEscalationRuleById(db, organizationId, ruleId);
  if (!existing) return false;
  await db
    .delete(supportEscalationRules)
    .where(
      and(
        eq(supportEscalationRules.id, ruleId),
        eq(supportEscalationRules.organizationId, organizationId)
      )
    );
  return true;
}

export function evaluateEscalationConditions(
  conditions: EscalationConditions,
  ticket: SupportTicket,
  ctx: EscalationContext
): boolean {
  const haystack = [ctx.subject ?? "", ctx.text ?? "", ticket.title].join("\n");

  if (conditions.keywords && conditions.keywords.length > 0) {
    const found = conditions.keywords.some((keyword) =>
      containsKeyword(keyword, haystack)
    );
    if (!found) return false;
  }

  if (conditions.channels && conditions.channels.length > 0) {
    const channel = ctx.channel ?? ticket.sourceChannel;
    if (!channel || !conditions.channels.includes(channel as never)) {
      return false;
    }
  }

  if (conditions.priorities && conditions.priorities.length > 0) {
    if (!conditions.priorities.includes(ticket.priority as never)) {
      return false;
    }
  }

  if (conditions.statuses && conditions.statuses.length > 0) {
    if (!conditions.statuses.includes(ticket.status as never)) {
      return false;
    }
  }

  if (conditions.sources && conditions.sources.length > 0) {
    const source = ctx.source ?? ticket.externalSource;
    if (!source || !conditions.sources.includes(source as never)) {
      return false;
    }
  }

  if (conditions.customerDomains && conditions.customerDomains.length > 0) {
    const email = ctx.customer?.email;
    const domain = domainFromEmail(email);
    const domains = conditions.customerDomains.map((d) => d.toLowerCase());
    if (!domain || !domains.includes(domain)) {
      return false;
    }
  }

  return true;
}

function getWorkspaceStub(env: WorkerEnv, organizationId: string) {
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  return env.WORKSPACE_DURABLE_OBJECT.get(doId);
}

export async function maybeEscalate(
  env: WorkerEnv,
  db: D1Client,
  organizationId: string,
  ticket: SupportTicket,
  ctx: EscalationContext
): Promise<Issue | null> {
  if (ticket.issueId) return null;

  const rules = await getActiveEscalationRules(db, organizationId);

  const matched = rules.find((rule) => {
    const conditions = parseEscalationRuleConditions(rule.conditions);
    return evaluateEscalationConditions(conditions, ticket, ctx);
  });
  if (!matched) return null;

  const action = parseEscalationRuleAction(matched.action);
  return createIssueFromTicket(
    env,
    db,
    organizationId,
    ticket,
    ctx,
    action,
    matched.id
  );
}

async function createIssueFromTicket(
  env: WorkerEnv,
  db: D1Client,
  organizationId: string,
  ticket: SupportTicket,
  ctx: EscalationContext,
  action: EscalationAction,
  ruleId: string
): Promise<Issue> {
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const description = buildEscalationDescription(ticket, ctx);
  const now = new Date().toISOString();

  const issue = await stub.createIssue({
    title: ticket.title,
    description,
    status: action.status ?? "triage",
    priority: action.priority ?? ticket.priority,
    teamId: action.teamId,
    labelIds:
      action.labelIds && action.labelIds.length > 0
        ? action.labelIds.join(",")
        : null,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(supportTickets)
    .set({ issueId: issue.id, updatedAt: now })
    .where(
      and(
        eq(supportTickets.id, ticket.id),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  await db.insert(supportTicketEvents).values({
    id: crypto.randomUUID(),
    ticketId: ticket.id,
    type: "link_added",
    actorType: "automation",
    actorId: ruleId,
    metadata: JSON.stringify({ issueId: issue.id, ruleId }),
    createdAt: now,
  });

  return issue;
}

function buildEscalationDescription(
  ticket: SupportTicket,
  ctx: EscalationContext
): string {
  const lines = [
    `Escalated from support ticket ${ticket.number}`,
    `Customer: ${ctx.customer?.email ?? "unknown"}`,
    `Channel: ${ctx.channel ?? ticket.sourceChannel}`,
    `Source: ${ctx.source ?? ticket.externalSource}`,
    "",
    ctx.text || "",
  ];
  return lines.join("\n").trim();
}

// Triage auto-delegate rules (PILE-427 — Linear triage rules): ordered
// match rules evaluated against inbound records — leads, intake items,
// customers, deals, issues, support tickets. The first matching rule wins;
// every evaluation (match or not) lands in triage_rule_evaluations so the
// log answers "which rule matched this record".
//
// Rules and the evaluation log live in the workspace Durable Object
// (per-workspace state); this module holds the zod contract, the matcher,
// and the action runner that sits in the API/channel layer where both the
// D1 client and the DO stub are reachable.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { WorkerEnv } from "../platform/middleware.js";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type Issue,
  type IssuePatch,
} from "../types/workspace.js";
import { DEAL_STAGES } from "../workspace/data/index.js";
import type { D1Client } from "./db.js";
import { supportTickets } from "./schema.js";
import {
  linkIssueToTicket,
  SUPPORT_TICKET_STATUSES,
} from "./support-escalation.js";
import { getTeamById } from "./teams.js";
import { getTemplate, issueTemplateDataSchema } from "./templates.js";

export const TRIAGE_RECORD_TYPES = [
  "lead",
  "intake_item",
  "customer",
  "deal",
  "issue",
  "support_ticket",
] as const;
export type TriageRecordType = (typeof TRIAGE_RECORD_TYPES)[number];

export const TRIAGE_EVALUATION_OUTCOMES = [
  "matched",
  "no_match",
  "error",
] as const;
export type TriageEvaluationOutcome =
  (typeof TRIAGE_EVALUATION_OUTCOMES)[number];

/** Field-level match — same semantics as stage-template step conditions:
 *  `{field}` alone means the record field must resolve truthy; `equals`
 *  compares the stored value. Field names are normalized (separators
 *  collapse) so `hardware_needed` matches `hardwareNeeded`. */
export const triageFieldConditionSchema = z.object({
  field: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type TriageFieldCondition = z.infer<typeof triageFieldConditionSchema>;

/** Every declared key is an AND'd constraint; each array is an OR within
 *  itself. An absent key never constrains. */
export const triageConditionsSchema = z.object({
  keywords: z.array(z.string().min(1)).optional(),
  sources: z.array(z.string().min(1)).optional(),
  channels: z.array(z.string().min(1)).optional(),
  customerDomains: z.array(z.string().min(1)).optional(),
  teamIds: z.array(z.string().min(1)).optional(),
  labelIds: z.array(z.string().min(1)).optional(),
  priorities: z.array(z.string().min(1)).optional(),
  statuses: z.array(z.string().min(1)).optional(),
  fields: z.array(triageFieldConditionSchema).optional(),
});
export type TriageConditions = z.infer<typeof triageConditionsSchema>;

/** Delegate the record to an agent: for issue records sets delegateId (and
 *  optionally status) on the issue itself; for any other inbound record it
 *  materializes the record's working issue (idempotent id
 *  `triage:{type}:{recordId}`), links it back to the record, sets the
 *  delegate, and — unless `dispatch: false` — starts a lane. */
export const triageDelegateActionSchema = z.object({
  type: z.literal("delegate"),
  agentId: z.string().min(1),
  teamId: z.string().optional(),
  templateId: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  labelIds: z.array(z.string().min(1)).optional(),
  repo: z.string().optional(),
  instructions: z.string().optional(),
  dispatch: z.boolean().optional(),
});
export type TriageDelegateAction = z.infer<typeof triageDelegateActionSchema>;

/** Set the record's own status: issue → status, deal → stage, customer →
 *  statusId, support_ticket → status, intake_item → its customer's
 *  statusId, lead → its deal's stage. */
export const triageSetStatusActionSchema = z.object({
  type: z.literal("set_status"),
  status: z.string().min(1),
});
export type TriageSetStatusAction = z.infer<typeof triageSetStatusActionSchema>;

export const triageActionSchema = z.discriminatedUnion("type", [
  triageDelegateActionSchema,
  triageSetStatusActionSchema,
]);
export type TriageAction = z.infer<typeof triageActionSchema>;

/** The normalized record the matcher and the action runner read. Callers
 *  build one view per inbound record; `fields` carries the flat record
 *  attributes that `fields` conditions match against. */
export type TriageRecordView = {
  recordType: TriageRecordType;
  recordId: string;
  /** Default title for a materialized issue (delegate on non-issues). */
  title?: string;
  /** Text the keyword matcher reads — subject + body + title. */
  text: string;
  source?: string | null;
  channel?: string | null;
  customerEmail?: string | null;
  teamId?: string | null;
  labelIds?: string[];
  priority?: string | null;
  status?: string | null;
  fields?: Record<string, unknown>;
  /** The record's deal (leads materialize deals), when one exists. */
  dealId?: string | null;
  /** The record's workspace customer row, when one exists. */
  customerId?: string | null;
};

export type TriageEvaluationResult = {
  outcome: TriageEvaluationOutcome;
  ruleId: string | null;
  ruleName: string | null;
  /** Issue materialized or updated by a delegate action. */
  issueId: string | null;
  detail: Record<string, unknown>;
};

function getWorkspaceStub(env: WorkerEnv, organizationId: string) {
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  return env.WORKSPACE_DURABLE_OBJECT.get(doId);
}

function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const parts = email.split("@");
  return parts[1]?.toLowerCase() ?? null;
}

// Mirrors conditionFieldKey in src/workspace/data/index.ts — field
// conditions share the stage-template normalization so a rule written for
// "Hardware needed" matches `hardware_needed`/`hardwareNeeded` alike.
function conditionFieldKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0) return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return (
      lowered !== "" &&
      lowered !== "false" &&
      lowered !== "0" &&
      lowered !== "no"
    );
  }
  return true;
}

function evaluateFieldCondition(
  condition: TriageFieldCondition,
  fields: Record<string, unknown>
): boolean {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    normalized[conditionFieldKey(key)] = value;
  }
  const value = normalized[conditionFieldKey(condition.field)];
  if (condition.equals !== undefined) {
    if (value === undefined || value === null) return false;
    return String(value) === String(condition.equals);
  }
  return isTruthy(value);
}

export function evaluateTriageConditions(
  conditions: TriageConditions,
  view: TriageRecordView
): boolean {
  if (conditions.keywords && conditions.keywords.length > 0) {
    const haystack = view.text.toLowerCase();
    const found = conditions.keywords.some((keyword) =>
      haystack.includes(keyword.toLowerCase())
    );
    if (!found) return false;
  }
  if (conditions.sources && conditions.sources.length > 0) {
    if (!view.source || !conditions.sources.includes(view.source)) {
      return false;
    }
  }
  if (conditions.channels && conditions.channels.length > 0) {
    if (!view.channel || !conditions.channels.includes(view.channel)) {
      return false;
    }
  }
  if (conditions.customerDomains && conditions.customerDomains.length > 0) {
    const domain = domainFromEmail(view.customerEmail);
    const domains = conditions.customerDomains.map((d) => d.toLowerCase());
    if (!domain || !domains.includes(domain)) return false;
  }
  if (conditions.teamIds && conditions.teamIds.length > 0) {
    if (!view.teamId || !conditions.teamIds.includes(view.teamId)) {
      return false;
    }
  }
  if (conditions.labelIds && conditions.labelIds.length > 0) {
    const recordLabels = view.labelIds ?? [];
    if (!conditions.labelIds.some((id) => recordLabels.includes(id))) {
      return false;
    }
  }
  if (conditions.priorities && conditions.priorities.length > 0) {
    if (!view.priority || !conditions.priorities.includes(view.priority)) {
      return false;
    }
  }
  if (conditions.statuses && conditions.statuses.length > 0) {
    if (!view.status || !conditions.statuses.includes(view.status)) {
      return false;
    }
  }
  if (conditions.fields && conditions.fields.length > 0) {
    const fields = view.fields ?? {};
    const all = conditions.fields.every((condition) =>
      evaluateFieldCondition(condition, fields)
    );
    if (!all) return false;
  }
  return true;
}

export function serializeTriageConditions(
  conditions: TriageConditions
): string {
  return JSON.stringify(triageConditionsSchema.parse(conditions));
}

export function serializeTriageAction(action: TriageAction): string {
  return JSON.stringify(triageActionSchema.parse(action));
}

export function parseTriageConditions(raw: string): TriageConditions {
  const result = triageConditionsSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`Invalid triage conditions: ${result.error.message}`);
  }
  return result.data;
}

export function parseTriageAction(raw: string): TriageAction {
  const result = triageActionSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`Invalid triage action: ${result.error.message}`);
  }
  return result.data;
}

type WorkspaceStub = ReturnType<typeof getWorkspaceStub>;

async function recordEvaluation(
  stub: WorkspaceStub,
  input: {
    recordType: TriageRecordType;
    recordId: string;
    ruleId?: string | null;
    ruleName?: string | null;
    outcome: TriageEvaluationOutcome;
    detail?: Record<string, unknown> | null;
  }
): Promise<void> {
  try {
    await stub.recordTriageEvaluation({
      recordType: input.recordType,
      recordId: input.recordId,
      ruleId: input.ruleId ?? null,
      ruleName: input.ruleName ?? null,
      outcome: input.outcome,
      detail: input.detail ? JSON.stringify(input.detail) : null,
    });
  } catch (err) {
    // The log is observability, not correctness — a failed write must not
    // break the inbound path it annotates.
    console.error("triage evaluation log write failed", {
      recordType: input.recordType,
      recordId: input.recordId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Evaluate the workspace's active rules for this record — ordered by
 *  sortOrder then createdAt, first match wins — apply the matched action,
 *  and log the outcome. Returns null when no rules exist for the record
 *  type (nothing evaluated, nothing logged). Never throws for action
 *  failures — those land in the log as outcome "error". */
export async function runTriageRules(
  env: WorkerEnv,
  db: D1Client,
  organizationId: string,
  view: TriageRecordView,
  opts?: { ctx?: { waitUntil: (promise: Promise<unknown>) => void } }
): Promise<TriageEvaluationResult | null> {
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const rules = await stub.listTriageRules({
    recordType: view.recordType,
    activeOnly: true,
  });
  if (rules.length === 0) return null;

  // A rule whose stored conditions no longer parse is skipped — it can
  // never be the first match, and must not shadow the rules behind it.
  const matched = rules.find((rule) => {
    try {
      return evaluateTriageConditions(
        parseTriageConditions(rule.conditions),
        view
      );
    } catch {
      return false;
    }
  });

  if (!matched) {
    await recordEvaluation(stub, {
      recordType: view.recordType,
      recordId: view.recordId,
      outcome: "no_match",
    });
    return {
      outcome: "no_match",
      ruleId: null,
      ruleName: null,
      issueId: null,
      detail: {},
    };
  }

  let action: TriageAction;
  try {
    action = parseTriageAction(matched.action);
  } catch (err) {
    const detail = {
      error: err instanceof Error ? err.message : String(err),
    };
    await recordEvaluation(stub, {
      recordType: view.recordType,
      recordId: view.recordId,
      ruleId: matched.id,
      ruleName: matched.name,
      outcome: "error",
      detail,
    });
    return {
      outcome: "error",
      ruleId: matched.id,
      ruleName: matched.name,
      issueId: null,
      detail,
    };
  }

  try {
    const detail = await applyTriageAction(
      env,
      db,
      stub,
      organizationId,
      matched.id,
      matched.name,
      action,
      view,
      opts
    );
    await recordEvaluation(stub, {
      recordType: view.recordType,
      recordId: view.recordId,
      ruleId: matched.id,
      ruleName: matched.name,
      outcome: "matched",
      detail,
    });
    return {
      outcome: "matched",
      ruleId: matched.id,
      ruleName: matched.name,
      issueId: (detail.issueId as string | undefined) ?? null,
      detail,
    };
  } catch (err) {
    const detail = {
      error: err instanceof Error ? err.message : String(err),
    };
    console.error("triage rule action failed", {
      ruleId: matched.id,
      recordType: view.recordType,
      recordId: view.recordId,
      error: detail.error,
    });
    await recordEvaluation(stub, {
      recordType: view.recordType,
      recordId: view.recordId,
      ruleId: matched.id,
      ruleName: matched.name,
      outcome: "error",
      detail,
    });
    return {
      outcome: "error",
      ruleId: matched.id,
      ruleName: matched.name,
      issueId: null,
      detail,
    };
  }
}

async function applyTriageAction(
  env: WorkerEnv,
  db: D1Client,
  stub: WorkspaceStub,
  organizationId: string,
  ruleId: string,
  ruleName: string,
  action: TriageAction,
  view: TriageRecordView,
  opts?: { ctx?: { waitUntil: (promise: Promise<unknown>) => void } }
): Promise<Record<string, unknown>> {
  if (action.type === "delegate") {
    return applyDelegateAction(
      env,
      db,
      stub,
      organizationId,
      ruleId,
      ruleName,
      action,
      view,
      opts
    );
  }
  return applySetStatusAction(db, stub, organizationId, action, view);
}

async function resolveTemplateData(
  db: D1Client,
  organizationId: string,
  templateId: string
) {
  const template = await getTemplate(db, organizationId, templateId);
  if (!template) {
    throw new Error(`Triage template not found: ${templateId}`);
  }
  if (!template.templateData) return {};
  const result = issueTemplateDataSchema.safeParse(
    JSON.parse(template.templateData)
  );
  if (!result.success) {
    throw new Error("Triage template has invalid data");
  }
  return result.data;
}

function buildTriageIssueDescription(
  view: TriageRecordView,
  ruleName: string
): string {
  const lines = [
    `Auto-delegated by triage rule "${ruleName}"`,
    `Record: ${view.recordType} ${view.recordId}`,
    view.customerEmail ? `Contact: ${view.customerEmail}` : null,
    view.source ? `Source: ${view.source}` : null,
    view.channel ? `Channel: ${view.channel}` : null,
    "",
    view.text,
  ];
  return lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .trim();
}

function defaultDelegateInstructions(
  view: TriageRecordView,
  ruleName: string
): string {
  return [
    `Triage rule "${ruleName}" delegated this ${view.recordType} to you.`,
    `Work the linked issue; your completion summary lands back on the record.`,
    "",
    view.text.slice(0, 2000),
  ].join("\n");
}

async function applyDelegateAction(
  env: WorkerEnv,
  db: D1Client,
  stub: WorkspaceStub,
  organizationId: string,
  ruleId: string,
  ruleName: string,
  action: TriageDelegateAction,
  view: TriageRecordView,
  opts?: { ctx?: { waitUntil: (promise: Promise<unknown>) => void } }
): Promise<Record<string, unknown>> {
  const template = action.templateId
    ? await resolveTemplateData(db, organizationId, action.templateId)
    : {};
  // Same fallback the issues API applies: an explicit repo wins, else the
  // team's defaultRepo so a dispatched lane clones something real.
  const teamDefaultRepo = action.teamId
    ? ((await getTeamById(db, action.teamId, organizationId))?.defaultRepo ??
      undefined)
    : undefined;

  let issue: Issue | undefined;
  if (view.recordType === "issue") {
    // The record already is an issue — stamp delegate (and any template /
    // action fields) on it rather than materializing a new one.
    const patch: IssuePatch = {
      delegateId: action.agentId,
      ...(template.status !== undefined ? { status: template.status } : {}),
      ...(template.priority !== undefined
        ? { priority: template.priority }
        : {}),
      ...(template.description !== undefined
        ? { description: template.description }
        : {}),
      ...(template.estimate !== undefined
        ? { estimate: template.estimate }
        : {}),
      ...(template.assigneeId !== undefined
        ? { assigneeId: template.assigneeId }
        : {}),
      ...(template.projectId !== undefined
        ? { projectId: template.projectId }
        : {}),
      ...(template.cycleId !== undefined ? { cycleId: template.cycleId } : {}),
      ...(template.labelIds !== undefined
        ? { labelIds: template.labelIds }
        : {}),
      ...(action.status !== undefined ? { status: action.status } : {}),
      ...(action.priority !== undefined ? { priority: action.priority } : {}),
      ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.labelIds !== undefined
        ? { labelIds: action.labelIds.join(",") }
        : {}),
      ...(action.teamId !== undefined ? { teamId: action.teamId } : {}),
      ...(action.repo !== undefined ? { repo: action.repo } : {}),
    };
    issue = await stub.updateIssue(view.recordId, patch, ruleId);
    if (!issue) {
      throw new Error(`Issue record not found: ${view.recordId}`);
    }
  } else {
    const now = new Date().toISOString();
    const issueId = `triage:${view.recordType}:${view.recordId}`;
    issue = await stub.createIssue(
      {
        id: issueId,
        title:
          action.title ??
          template.title ??
          view.title ??
          `Triage: ${view.recordType} ${view.recordId}`,
        description:
          template.description ?? buildTriageIssueDescription(view, ruleName),
        status: action.status ?? template.status ?? "triage",
        priority: action.priority ?? template.priority ?? "medium",
        teamId: action.teamId,
        repo: action.repo ?? teamDefaultRepo,
        labelIds:
          action.labelIds && action.labelIds.length > 0
            ? action.labelIds.join(",")
            : (template.labelIds ?? null),
        delegateId: action.agentId,
        assigneeId: template.assigneeId ?? null,
        projectId: template.projectId ?? null,
        cycleId: template.cycleId ?? null,
        createdAt: now,
        updatedAt: now,
      },
      ruleId
    );

    // Record linkages — the deal edge is the canonical one the deals API
    // reads; other record types hang off the generic entity link.
    if (view.dealId) {
      await stub.linkDealIssue(view.dealId, issue.id);
    }
    if (view.recordType === "support_ticket") {
      await linkIssueToTicket(
        db,
        organizationId,
        view.recordId,
        issue.id,
        ruleId,
        {
          ruleId,
          source: "triage",
        }
      );
    } else {
      await stub.linkEntities({
        fromType: view.recordType,
        fromId: view.recordId,
        toType: "issue",
        toId: issue.id,
        kind: "triage",
      });
    }
  }

  const detail: Record<string, unknown> = { issueId: issue.id };
  if (action.dispatch !== false) {
    const { dispatchAgent } = await import("../agents/index.js");
    const session = await dispatchAgent(
      env,
      action.agentId,
      organizationId,
      issue,
      { id: ruleId, organizationId, type: "agent", permissions: [] },
      undefined,
      opts?.ctx,
      {
        instructions:
          action.instructions ?? defaultDelegateInstructions(view, ruleName),
      }
    );
    detail.sessionId = session.id;
  }
  return detail;
}

function assertEnumValue<const T extends readonly string[]>(
  value: string,
  allowed: T,
  what: string
): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `set_status target "${value}" is not a valid ${what} (${allowed.join(", ")})`
    );
  }
  return value as T[number];
}

async function applySetStatusAction(
  db: D1Client,
  stub: WorkspaceStub,
  organizationId: string,
  action: TriageSetStatusAction,
  view: TriageRecordView
): Promise<Record<string, unknown>> {
  switch (view.recordType) {
    case "issue": {
      const status = assertEnumValue(
        action.status,
        ISSUE_STATUSES,
        "issue status"
      );
      await stub.updateIssue(view.recordId, { status }, undefined);
      return { applied: true, status };
    }
    case "deal": {
      const stage = assertEnumValue(action.status, DEAL_STAGES, "deal stage");
      await stub.updateDeal(view.recordId, { stage }, undefined);
      return { applied: true, stage };
    }
    case "customer": {
      return setCustomerStatus(stub, view.recordId, action.status);
    }
    case "intake_item": {
      // The intake item has no status of its own — the status lands on the
      // customer record the item was filed under.
      if (!view.customerId) {
        return { applied: false, reason: "no customer on intake item" };
      }
      return setCustomerStatus(stub, view.customerId, action.status);
    }
    case "lead": {
      // A lead's pipeline state is its deal's stage (leads materialize
      // deals); without a deal there is nothing status-bearing to write.
      if (!view.dealId) {
        return { applied: false, reason: "lead has no deal" };
      }
      const stage = assertEnumValue(action.status, DEAL_STAGES, "deal stage");
      await stub.updateDeal(view.dealId, { stage }, undefined);
      return { applied: true, stage, dealId: view.dealId };
    }
    case "support_ticket": {
      const status = assertEnumValue(
        action.status,
        SUPPORT_TICKET_STATUSES,
        "support ticket status"
      );
      const updated = await db
        .update(supportTickets)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(supportTickets.id, view.recordId),
            eq(supportTickets.organizationId, organizationId)
          )
        )
        .returning({ id: supportTickets.id })
        .get();
      if (!updated) {
        throw new Error(`Support ticket not found: ${view.recordId}`);
      }
      return { applied: true, status };
    }
  }
}

async function setCustomerStatus(
  stub: WorkspaceStub,
  customerId: string,
  statusId: string
): Promise<Record<string, unknown>> {
  const status = await stub.getCustomerStatus(statusId);
  if (!status) {
    throw new Error(
      `set_status target "${statusId}" is not a known customer status`
    );
  }
  await stub.updateCustomer(customerId, { statusId }, undefined);
  return { applied: true, statusId };
}

import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { dispatchAgent } from "./index.js";
import { automationEventTarget } from "./repo-triggers.js";
import { fireEventAutomations } from "./sweep.js";

/** PILE-401/405/413 — drains the DO's domain-event outbox into agent
 *  dispatches and stage policy. The DO emits events inside mutations (it
 *  cannot call providers); the worker drains them here — post-write via
 *  waitUntil for fast paths, and from the 5-minute sweep as a backstop for
 *  internal mutations (triage, external-event deliveries, automation). */

type Stub = DurableObjectStub<WorkspaceDO>;

const PIPELINE_ACTOR = {
  id: "pipeline-runtime",
  organizationId: "",
  type: "agent" as const,
  permissions: [] as string[],
};

interface StageEnteredPayload {
  entityType: "customer" | "deal" | "issue";
  entityId: string;
  from: string | null;
  to: string | null;
  toName?: string | null;
}

interface ActionablePayload {
  issueId: string;
  parentId: string;
  stepKey: string | null;
  ownerAgent: string | null;
  required: boolean;
}

interface AllDonePayload {
  parentId: string;
  completedBy: string;
  stepKey: string | null;
}

const DEAL_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;

/** The issue a record-scoped dispatch anchors to — the deal/customer's
 *  linked parent issue, auto-created + linked when the record has none
 *  (merchant deal = parent issue; VOR-701). */
async function pipelineIssueFor(
  stub: Stub,
  entityType: "customer" | "deal",
  entityId: string
): Promise<Issue | null> {
  const links = await stub.listEntityLinks(entityType, entityId);
  const issueId = links
    .map((link) =>
      link.fromType === "issue"
        ? link.fromId
        : link.toType === "issue"
          ? link.toId
          : null
    )
    .find((id): id is string => id !== null);
  if (issueId) {
    const issue = await stub.getIssue(issueId);
    if (issue) return issue;
  }
  const name =
    entityType === "customer"
      ? (await stub.getCustomer(entityId))?.name
      : (await stub.getDeal(entityId))?.name;
  if (!name) return null;
  const issue = await stub.createIssue(
    { title: `Pipeline: ${name}` },
    PIPELINE_ACTOR.id
  );
  await stub.linkEntities({
    fromType: "issue",
    fromId: issue.id,
    toType: entityType,
    toId: entityId,
  });
  return issue;
}

/** owner_agent slug → registered agent type → provider id + job spec. */
async function resolveOwner(
  stub: Stub,
  slug: string | null
): Promise<{
  agentId: string;
  slug: string;
  name: string;
  kind: string;
  jobSpec: string | null;
  toolScope: string | null;
} | null> {
  if (!slug) return null;
  const type = await stub.getAgentTypeBySlug(slug);
  if (!type) return null;
  return {
    agentId: type.providerAgentId,
    slug: type.slug,
    name: type.name,
    kind: type.kind ?? "agent",
    jobSpec: type.jobSpec,
    toolScope: type.toolScope,
  };
}

/** Durable conversation key for per-merchant agent memory — the flue
 *  worker names the conversation after this, so a profile's context for
 *  a merchant survives across dispatches. */
function conversationKey(recordId: string, agentSlug: string): string {
  return `${recordId}-${agentSlug}`;
}

async function handleStageEntered(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  payload: StageEnteredPayload,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const stageName = payload.toName ?? payload.to;
  if (!stageName || payload.entityType === "issue") return;
  const config = await stub.getStageConfig(payload.entityType, stageName);
  if (!config?.ownerAgent) return;
  const owner = await resolveOwner(stub, config.ownerAgent);
  if (!owner || owner.kind === "human") return;
  const issue = await pipelineIssueFor(
    stub,
    payload.entityType,
    payload.entityId
  );
  if (!issue) return;
  const record =
    payload.entityType === "customer"
      ? await stub.getCustomer(payload.entityId)
      : await stub.getDeal(payload.entityId);
  const instructions = [
    config.instructions ?? owner.jobSpec ?? "",
    "",
    `Pipeline stage: ${stageName}`,
    `Record (${payload.entityType}):`,
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ]
    .filter((part) => part !== "")
    .join("\n");
  await dispatchAgent(
    env,
    owner.agentId,
    organizationId,
    issue,
    { ...PIPELINE_ACTOR, organizationId },
    undefined,
    ctx,
    { instructions, stepKey: stageName }
  );
}

/** PILE-376 — status-triggered schedules ride the domain-event spine:
 *  an automation with trigger `record.stage_entered` fires on any record
 *  advance; `record.stage_entered:<stage>` binds to one stage. */
async function fireStageAutomations(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  payload: StageEnteredPayload,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  if (payload.entityType === "issue") return;
  const stageName = payload.toName ?? payload.to ?? "";
  const target = automationEventTarget(() =>
    pipelineIssueFor(
      stub,
      payload.entityType as "customer" | "deal",
      payload.entityId
    )
  );
  await fireEventAutomations(
    env,
    stub,
    organizationId,
    "record.stage_entered",
    target,
    `Record ${payload.entityType} ${payload.entityId} entered stage ${stageName}`,
    ctx,
    { body: stageName }
  );
  if (stageName) {
    await fireEventAutomations(
      env,
      stub,
      organizationId,
      `record.stage_entered:${stageName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      target,
      `Record ${payload.entityType} ${payload.entityId} entered stage ${stageName}`,
      ctx,
      { body: stageName }
    );
  }
}

async function handleSubstepActionable(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  payload: ActionablePayload,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const issue = await stub.getIssue(payload.issueId);
  if (!issue || !issue.ownerAgent) return;
  // Only dispatch work that's still open.
  if (issue.status !== "todo" && issue.status !== "in_progress") return;
  const owner = await resolveOwner(stub, issue.ownerAgent);
  if (owner?.kind === "human") return;
  if (!owner) {
    // PILE-413 — ownerless/unresolvable sub-steps go to the Chief of Staff
    // queue: flagged for a human rather than silently undispatched.
    await stub.createComment({
      issueId: issue.id,
      body: `No registered agent type for owner_agent "${issue.ownerAgent}" — routed to Chief of Staff queue.`,
      externalAuthor: "pipeline",
      externalSource: "pipeline-runtime",
    });
    return;
  }
  const parent = await stub.getIssue(payload.parentId);
  const instructions = [
    owner.jobSpec ??
      `Complete pipeline sub-step "${issue.stepKey ?? issue.title}".`,
    "",
    `Sub-step: ${issue.title} (${issue.stepKey ?? "unkeyed"})`,
    parent
      ? `Parent deal issue: ${parent.identifier ?? parent.id} — ${parent.title}`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
  await dispatchAgent(
    env,
    owner.agentId,
    organizationId,
    issue,
    { ...PIPELINE_ACTOR, organizationId },
    undefined,
    ctx,
    {
      instructions,
      stepKey: issue.stepKey ?? undefined,
      agentProfile: {
        slug: owner.slug,
        name: owner.name,
        jobSpec: owner.jobSpec,
        toolScope: owner.toolScope,
      },
      conversationKey: conversationKey(payload.parentId, owner.slug),
    }
  );
}

/** The record a parent's sub-steps belong to — the issue's linked deal or
 *  customer; falls back to the issue itself (issue-entityType pipelines). */
async function linkedRecord(
  stub: Stub,
  parentId: string
): Promise<
  | { entityType: "customer" | "deal"; id: string; stageKey: string }
  | { entityType: "issue"; id: string; stageKey: string }
  | null
> {
  const links = await stub.listEntityLinks("issue", parentId);
  for (const link of links) {
    const otherType = link.fromType === "issue" ? link.toType : link.fromType;
    const otherId = link.fromType === "issue" ? link.toId : link.fromId;
    if (otherType === "customer") {
      const customer = await stub.getCustomer(otherId);
      if (!customer?.statusId) continue;
      const status = await stub.getCustomerStatus(customer.statusId);
      return {
        entityType: "customer",
        id: otherId,
        stageKey: status?.name ?? customer.statusId,
      };
    }
    if (otherType === "deal") {
      const deal = await stub.getDeal(otherId);
      if (deal)
        return { entityType: "deal", id: otherId, stageKey: deal.stage };
    }
  }
  const parent = await stub.getIssue(parentId);
  return parent
    ? { entityType: "issue", id: parent.id, stageKey: parent.status }
    : null;
}

async function nextStage(
  stub: Stub,
  record: {
    entityType: "customer" | "deal" | "issue";
    id: string;
    stageKey: string;
  }
): Promise<{ patch: Record<string, unknown>; label: string | null }> {
  if (record.entityType === "customer") {
    const statuses = (await stub.listCustomerStatuses()).toSorted(
      (a, b) => a.position - b.position
    );
    const current = await stub.getCustomer(record.id);
    const idx = statuses.findIndex((s) => s.id === current?.statusId);
    const next = idx >= 0 ? statuses[idx + 1] : undefined;
    return { patch: { statusId: next?.id }, label: next?.name ?? null };
  }
  if (record.entityType === "deal") {
    const deal = await stub.getDeal(record.id);
    const idx = deal ? DEAL_STAGES.indexOf(deal.stage) : -1;
    const next = idx >= 0 ? DEAL_STAGES[idx + 1] : undefined;
    return { patch: { stage: next }, label: next ?? null };
  }
  const parent = await stub.getIssue(record.id);
  const order = ["triage", "backlog", "todo", "in_progress", "done"];
  const idx = parent ? order.indexOf(parent.status) : -1;
  const next = idx >= 0 ? order[idx + 1] : undefined;
  return { patch: { status: next }, label: next ?? null };
}

async function handleAllRequiredDone(
  stub: Stub,
  payload: AllDonePayload
): Promise<void> {
  const record = await linkedRecord(stub, payload.parentId);
  if (!record) return;
  const config = await stub.getStageConfig(record.entityType, record.stageKey);
  const policy = config?.advancePolicy ?? "none";
  if (policy === "none") return;
  if (policy === "ready_flag") {
    const reason = `Required sub-steps complete — ready to advance from ${record.stageKey}`;
    if (record.entityType === "customer") {
      await stub.updateCustomer(
        record.id,
        { needsHuman: true, needsHumanReason: reason },
        PIPELINE_ACTOR.id
      );
    } else if (record.entityType === "deal") {
      await stub.updateDeal(
        record.id,
        { needsHuman: true, needsHumanReason: reason },
        PIPELINE_ACTOR.id
      );
    }
    await stub.createComment({
      issueId: payload.parentId,
      body: `${reason}. Flagged for a human to advance.`,
      externalAuthor: "pipeline",
      externalSource: "pipeline-runtime",
    });
    return;
  }
  // auto — advance the record through the normal mutation path so the stage
  // gate re-checks (all required are done, so it passes) and the next
  // stage's templates + events fire.
  const { patch, label } = await nextStage(stub, record);
  if (!label) return;
  if (record.entityType === "customer") {
    await stub.updateCustomer(record.id, patch, PIPELINE_ACTOR.id);
  } else if (record.entityType === "deal") {
    await stub.updateDeal(record.id, patch, PIPELINE_ACTOR.id);
  } else {
    await stub.updateIssue(record.id, patch, PIPELINE_ACTOR.id);
  }
}

/** Drain pending domain events for one org. Failed deliveries stay
 *  `failed` with the error recorded — the sweep re-enters but does not
 *  retry them automatically (replays come through PILE-424's run
 *  inspector). */
export async function drainDomainEvents(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<number> {
  const events = await stub.listPendingDomainEvents();
  let delivered = 0;
  for (const event of events) {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (event.type === "record.stage_entered") {
        await handleStageEntered(
          env,
          stub,
          organizationId,
          payload as unknown as StageEnteredPayload,
          ctx
        );
        await fireStageAutomations(
          env,
          stub,
          organizationId,
          payload as unknown as StageEnteredPayload,
          ctx
        );
      } else if (event.type === "substep.actionable") {
        await handleSubstepActionable(
          env,
          stub,
          organizationId,
          payload as unknown as ActionablePayload,
          ctx
        );
      } else if (event.type === "substeps.all_required_done") {
        await handleAllRequiredDone(stub, payload as unknown as AllDonePayload);
      }
      await stub.markDomainEvent(event.id, "delivered");
      delivered += 1;
    } catch (error) {
      console.error("domain event delivery failed", {
        eventId: event.id,
        type: event.type,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      await stub
        .markDomainEvent(
          event.id,
          "failed",
          error instanceof Error ? error.message : String(error)
        )
        .catch(() => {});
    }
  }
  return delivered;
}

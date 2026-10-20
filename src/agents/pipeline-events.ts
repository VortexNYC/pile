import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { decryptSecret } from "./credentials.js";
import { dispatchAgent } from "./index.js";
import { automationEventTarget } from "./repo-triggers.js";
import { REVIEW_PURPOSE } from "./review.js";
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
  endpointUrl: string | null;
  endpointSecret: string | null;
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
    endpointUrl: type.endpointUrl ?? null,
    endpointSecret: type.endpointSecret ?? null,
    jobSpec: type.jobSpec,
    toolScope: type.toolScope,
  };
}

/** kind="external" owners (Grokbot as chief_of_staff, a customer's own
 *  automation) get the dispatch POSTed to their endpoint instead of a
 *  pile lane — same payload contract a CfAgentProvider would receive.
 *  PILE-441/443 — every attempt lands an internal delivery comment on
 *  the anchor issue (when one is passed) so failures are visible
 *  without worker logs. A failed POST throws so awaited drains mark
 *  the domain event `failed` and it stays replayable; waitUntil-fired
 *  dispatches swallow the throw since the event already delivered. */
async function dispatchExternal(
  env: WorkerEnv,
  stub: Stub,
  owner: {
    endpointUrl: string | null;
    endpointSecret: string | null;
    slug: string;
    name: string;
  },
  payload: Record<string, unknown>,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  delivery?: { issueId: string }
): Promise<void> {
  const endpointUrl = owner.endpointUrl;
  if (!endpointUrl) return;
  const secret = await decryptSecret(env, owner.endpointSecret);
  const eventType =
    typeof payload.event === "string" ? payload.event : "dispatch";
  const task = (async () => {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      status = res.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ok = error === null && status !== null && status < 300;
    const outcome = ok
      ? `delivered (HTTP ${status})`
      : `failed (${error ?? `HTTP ${status}`})`;
    if (!ok) {
      console.error(
        `external dispatch to ${owner.slug} (${endpointUrl}) ${outcome}`
      );
    }
    if (delivery) {
      await stub
        .createComment({
          issueId: delivery.issueId,
          body: `External dispatch \`${eventType}\` → \`${owner.slug}\`: ${outcome}`,
          internal: true,
          externalAuthor: "pipeline",
          externalSource: "pipeline-runtime",
        })
        .catch(() => {});
    }
    if (!ok) {
      throw new Error(
        `external dispatch to ${owner.slug} (${endpointUrl}) ${outcome}`
      );
    }
  })();
  if (ctx) ctx.waitUntil(task.catch(() => {}));
  else await task;
}

/** Page the registered chief_of_staff external owner — the escalation
 *  path for the org. Fires for lane deaths (agent.session_failed) and
 *  worker-raised escalations (agent.escalated). No-op when the chief
 *  isn't registered or isn't external. */
export async function pageChiefOfStaff(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  info: {
    event: "agent.session_failed" | "agent.escalated";
    issueId?: string;
    issueTitle?: string;
    issueIdentifier?: string | null;
    sessionId?: string;
    agentSlug?: string;
    conversationKey?: string | null;
    error?: string;
    question?: string;
  },
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const chief = await resolveOwner(stub, "chief_of_staff");
  if (!chief || chief.kind !== "external" || !chief.endpointUrl) return;
  await dispatchExternal(
    env,
    stub,
    chief,
    {
      event: info.event,
      organizationId,
      session: info.sessionId
        ? {
            id: info.sessionId,
            agentSlug: info.agentSlug ?? null,
            conversationKey: info.conversationKey ?? null,
          }
        : null,
      issue: info.issueId
        ? {
            id: info.issueId,
            identifier: info.issueIdentifier ?? null,
            title: info.issueTitle ?? null,
          }
        : null,
      error: info.error ?? null,
      question: info.question ?? null,
    },
    ctx,
    info.issueId ? { issueId: info.issueId } : undefined
  );
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
  if (owner.kind === "external") {
    if (!owner.endpointUrl) return;
    await dispatchExternal(
      env,
      stub,
      owner,
      {
        event: "record.stage_entered",
        organizationId,
        entityType: payload.entityType,
        entityId: payload.entityId,
        stage: stageName,
        agent: owner.slug,
        conversationKey: conversationKey(payload.entityId, owner.slug),
      },
      ctx
    );
    return;
  }
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
  if (owner?.kind === "external") {
    if (!owner.endpointUrl) return;
    const parentIssue = await stub.getIssue(payload.parentId);
    await dispatchExternal(
      env,
      stub,
      owner,
      {
        event: "substep.actionable",
        organizationId,
        issueId: issue.id,
        parentId: payload.parentId,
        stepKey: issue.stepKey ?? null,
        title: issue.title,
        agent: owner.slug,
        conversationKey: conversationKey(payload.parentId, owner.slug),
        parent: parentIssue
          ? { id: parentIssue.id, title: parentIssue.title }
          : null,
      },
      ctx,
      { issueId: issue.id }
    );
    return;
  }
  if (!owner) {
    // Unresolvable sub-steps escalate to the chief of staff — a registered
    // "chief_of_staff" agent type gets dispatched with the orphan step;
    // if none exists, fall back to a comment a human can triage.
    const chief = await resolveOwner(stub, "chief_of_staff");
    if (chief && chief.kind !== "human") {
      const parent = await stub.getIssue(payload.parentId);
      await dispatchAgent(
        env,
        chief.agentId,
        organizationId,
        issue,
        { ...PIPELINE_ACTOR, organizationId },
        undefined,
        ctx,
        {
          instructions: [
            chief.jobSpec ?? "Triage an orphaned pipeline sub-step.",
            "",
            `Unassigned sub-step: ${issue.title} (owner_agent "${issue.ownerAgent}" has no registered agent type)`,
            parent
              ? `Parent deal issue: ${parent.identifier ?? parent.id} — ${parent.title}`
              : "",
          ]
            .filter((part) => part !== "")
            .join("\n"),
          stepKey: issue.stepKey ?? undefined,
          agentProfile: {
            slug: chief.slug,
            name: chief.name,
            jobSpec: chief.jobSpec,
            toolScope: chief.toolScope,
          },
          conversationKey: conversationKey(payload.parentId, chief.slug),
        }
      );
      return;
    }
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
  try {
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
  } catch (dispatchErr) {
    // The lane died at dispatch — page the chief so a failed worker is
    // never silent. Rethrow so the event still marks failed.
    await pageChiefOfStaff(
      env,
      stub,
      organizationId,
      {
        event: "agent.session_failed",
        issueId: issue.id,
        issueTitle: issue.title,
        issueIdentifier: issue.identifier,
        agentSlug: owner.slug,
        conversationKey: conversationKey(payload.parentId, owner.slug),
        error:
          dispatchErr instanceof Error
            ? dispatchErr.message
            : String(dispatchErr),
      },
      ctx
    );
    throw dispatchErr;
  }
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
      // Claim before handling — concurrent drains (post-write waitUntil
      // paths + the sweep backstop) would otherwise both see the pending
      // row and double-POST the external reviewer (PILE-443). The loser
      // of the pending→delivering transition skips the event.
      if (!(await stub.claimDomainEvent(event.id))) continue;
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
      } else if (event.type === "substep.review") {
        await handleSubstepReview(
          env,
          stub,
          organizationId,
          payload as unknown as SubstepReviewPayload,
          ctx
        );
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

/** waitUntil-safe drain — the events persist regardless, so a rejected
 *  drain is only logged, never allowed to become an unhandled rejection
 *  on the request's execution ctx (the sweep is the backstop). */
export function drainDomainEventsInBackground(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): void {
  ctx?.waitUntil(
    drainDomainEvents(env, stub, organizationId, ctx).catch((err: unknown) => {
      console.error("domain event drain failed", {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    })
  );
}

interface SubstepReviewPayload {
  issueId: string;
  parentId: string;
  stepKey?: string | null;
  ownerAgent?: string | null;
  /** The lane whose terminal write raised the event (absent on the
   *  status-flag emit path — a human marking the step satisfied). */
  sessionId?: string | null;
  sessionStatus?: string | null;
  conversationKey?: string | null;
}

/** The reviewer for a gated sub-step: a dedicated `reviewer` agent
 *  type wins when registered; otherwise the stage owner (the stage
 *  config's owner_agent for the record the parent links to); otherwise
 *  chief_of_staff. Humans can't be auto-dispatched and external owners
 *  without an endpointUrl can't be woken — both fall through to the
 *  next candidate so a misconfigured reviewer can't stall the gate. */
async function resolveReviewer(
  stub: Stub,
  parentId: string
): Promise<Awaited<ReturnType<typeof resolveOwner>>> {
  const record = await linkedRecord(stub, parentId);
  const stageOwner = record
    ? ((await stub.getStageConfig(record.entityType, record.stageKey))
        ?.ownerAgent ?? null)
    : null;
  const seen = new Set<string>();
  for (const slug of ["reviewer", stageOwner, "chief_of_staff"]) {
    if (!slug) continue;
    // Slug normalization mirrors agent_types lookups — "chief-of-staff"
    // and "chief_of_staff" resolve to the same row.
    const key = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = await resolveOwner(stub, slug);
    if (!owner || owner.kind === "human") continue;
    if (owner.kind === "external" && !owner.endpointUrl) continue;
    return owner;
  }
  return null;
}

/** Review-gated chain — a completed required sub-step gets evaluated by
 *  a reviewer before the chain advances. An external reviewer gets the
 *  event POSTed to its endpoint (PILE-443); an internal one runs a
 *  verdict lane. Pass → the next sibling promotes (its
 *  substep.actionable fires on the status move); fail → page the
 *  chief. The gate keeps the belt from moving junk. */
async function handleSubstepReview(
  env: WorkerEnv,
  stub: Stub,
  organizationId: string,
  payload: SubstepReviewPayload,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const issue = await stub.getIssue(payload.issueId);
  if (!issue) return;
  const parent = await stub.getIssue(payload.parentId);
  const target = await resolveReviewer(stub, payload.parentId);
  const session = payload.sessionId
    ? {
        id: payload.sessionId,
        status: payload.sessionStatus ?? null,
        agentSlug: issue.ownerAgent ?? null,
        conversationKey: payload.conversationKey ?? null,
      }
    : null;

  // A dead lane isn't a verdict request — the reviewer (or the chief as
  // escalation owner) gets agent.session_failed. There's nothing to
  // score, so internal reviewers escalate instead of getting a lane.
  if (payload.sessionStatus === "failed") {
    if (target?.kind === "external" && target.endpointUrl) {
      await dispatchExternal(
        env,
        stub,
        target,
        {
          event: "agent.session_failed",
          organizationId,
          issueId: issue.id,
          parentId: payload.parentId,
          stepKey: issue.stepKey ?? null,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
          },
          parent: parent
            ? {
                id: parent.id,
                identifier: parent.identifier,
                title: parent.title,
              }
            : null,
          session,
          agent: target.slug,
          conversationKey: conversationKey(payload.parentId, target.slug),
        },
        ctx,
        { issueId: issue.id }
      );
      return;
    }
    await pageChiefOfStaff(
      env,
      stub,
      organizationId,
      {
        event: "agent.session_failed",
        issueId: issue.id,
        issueTitle: issue.title,
        issueIdentifier: issue.identifier,
        sessionId: payload.sessionId ?? undefined,
        agentSlug: issue.ownerAgent ?? undefined,
        conversationKey: payload.conversationKey ?? null,
        error: "sub-step lane failed — awaiting reviewer triage",
      },
      ctx
    );
    return;
  }

  if (target?.kind === "external") {
    // resolveReviewer filtered out endpoint-less externals, so a target
    // here always has a URL to wake; the internal lane below is the
    // fallback when every candidate was undispatchable.
    await dispatchExternal(
      env,
      stub,
      target,
      {
        event: "substep.ready_for_review",
        organizationId,
        issueId: issue.id,
        parentId: payload.parentId,
        stepKey: issue.stepKey ?? null,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
        },
        parent: parent
          ? {
              id: parent.id,
              identifier: parent.identifier,
              title: parent.title,
            }
          : null,
        session,
        agent: target.slug,
        conversationKey: conversationKey(payload.parentId, target.slug),
      },
      ctx,
      { issueId: issue.id }
    );
    return;
  }

  const agentId = target?.agentId ?? "devin-cli";
  const instructions = [
    target?.jobSpec ??
      "You are the reviewer. Evaluate the completed sub-step's output against its task: is it correct, complete, and ready to hand to the next step?",
    "",
    `Sub-step: ${issue.title} (${issue.stepKey ?? "unkeyed"})`,
    parent
      ? `Parent deal issue: ${parent.identifier ?? parent.id} — ${parent.title}`
      : "",
    "",
    'Return your verdict as JSON: {"verdict": "pass"|"fail", "reasons": "..."}.',
  ]
    .filter((part) => part !== "")
    .join("\n");
  await dispatchAgent(
    env,
    agentId,
    organizationId,
    issue,
    { ...PIPELINE_ACTOR, organizationId },
    undefined,
    ctx,
    {
      instructions,
      stepKey: issue.stepKey ?? undefined,
      purpose: REVIEW_PURPOSE,
      resultSchema: JSON.stringify({
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["pass", "fail"] },
          reasons: { type: "string" },
        },
        required: ["verdict"],
      }),
      agentProfile: target
        ? {
            slug: target.slug,
            name: target.name,
            jobSpec: target.jobSpec,
            toolScope: target.toolScope,
          }
        : undefined,
      conversationKey: conversationKey(payload.parentId, "reviewer"),
    }
  );
}

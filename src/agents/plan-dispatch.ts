// PILE-283 — plan-mode dispatch: plan lanes, PlanEdit revisions, and build
// lanes dispatched from the approved plan.

import { and, eq } from "drizzle-orm";

import type { D1Client } from "../global/db.js";
import { fetchPileRepoConfig } from "../global/pile-repo-config.js";
import { githubInstallations } from "../global/schema.js";
import { getLabel } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { dispatchAgent, inheritTeamDefaultRepo } from "./index.js";
import {
  buildImplementPlanInstructions,
  buildPlanInstructions,
  extractPlanText,
  findLatestPlanComment,
  PLAN_LABEL_NAME,
  PLAN_LANE_ENV,
  PLAN_NOTICE_SOURCE,
  PLAN_PURPOSE,
  type PlanCommand,
  type PlanMode,
} from "./plan.js";

interface LatestPlan {
  plan: string;
  commentId: string;
  sessionId: string | null;
}

async function loadLatestPlan(
  stub: DurableObjectStub<WorkspaceDO>,
  issueId: string
): Promise<LatestPlan | null> {
  const comments = await stub.listComments(issueId);
  const comment = findLatestPlanComment(comments);
  if (!comment) return null;
  const session = comment.externalId
    ? await stub.getAgentSession(comment.externalId)
    : null;
  const fromSession = extractPlanText(session?.result);
  const body = comments.find((c) => c.id === comment.id)?.body ?? "";
  return {
    plan: fromSession.length > 0 ? fromSession : body,
    commentId: comment.id,
    sessionId: session?.id ?? null,
  };
}

export interface PlanLaneOptions {
  instructions: string;
  purpose: string | null;
  extraEnv?: Record<string, string>;
  skipQueue?: boolean;
  plan: LatestPlan | null;
}

/** dispatchAgent options for a plan-mode lane. `feedback` revises the
 *  latest plan (PlanEdit); implement_plan requires a plan on the thread. */
export async function planLaneOptions(
  stub: DurableObjectStub<WorkspaceDO>,
  issue: Issue,
  mode: PlanMode,
  feedback: string | null
): Promise<PlanLaneOptions> {
  const latest = await loadLatestPlan(stub, issue.id);
  if (mode === "implement_plan") {
    if (!latest) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "No implementation plan on this issue",
        hint: 'Dispatch with mode "plan" (or comment /plan) first',
      });
    }
    return {
      instructions: buildImplementPlanInstructions(latest.plan),
      purpose: null,
      plan: latest,
    };
  }
  return {
    instructions: buildPlanInstructions(
      issue,
      latest ? { plan: latest.plan, feedback } : undefined
    ),
    purpose: PLAN_PURPOSE,
    extraEnv: PLAN_LANE_ENV,
    // Plan lanes never push, so PR-coverage queueing doesn't apply.
    skipQueue: true,
    plan: latest,
  };
}

/** Explicit agent → repo default agent → "devin", gated by the repo's
 *  `.pile/config.json` allowlist (PILE-221). */
export async function resolveDispatchAgent(
  env: WorkerEnv,
  db: D1Client,
  organizationId: string,
  target: Pick<Issue, "repo" | "branch">,
  requested: { agentId?: string; model?: string }
) {
  const repoDefault = target.repo
    ? (
        await db
          .select({ defaultAgentId: githubInstallations.defaultAgentId })
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.organizationId, organizationId),
              eq(githubInstallations.repo, target.repo)
            )
          )
          .get()
      )?.defaultAgentId
    : undefined;
  const agentId = requested.agentId ?? repoDefault ?? "devin";
  const pileConfig = target.repo
    ? await fetchPileRepoConfig(env, target.repo, target.branch)
    : null;
  if (
    pileConfig?.agents &&
    pileConfig.agents.length > 0 &&
    !pileConfig.agents.includes(agentId)
  ) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Agent "${agentId}" is not allowed by .pile/config.json (allowed: ${pileConfig.agents.join(", ")})`,
    });
  }
  return { agentId, model: requested.model ?? pileConfig?.model, pileConfig };
}

/** Records which plan a build lane was dispatched from. */
export async function notePlanSource(
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  plan: LatestPlan | null
): Promise<void> {
  if (!plan) return;
  await stub
    .addAgentSessionEvent({
      sessionId: session.id,
      type: "lane.plan",
      message:
        session.purpose === PLAN_PURPOSE
          ? "Revising the latest implementation plan"
          : "Dispatched from the approved implementation plan",
      payload: { commentId: plan.commentId, planSessionId: plan.sessionId },
    })
    .catch(() => {});
}

/** Comment/label triggers: dispatch a plan-mode lane on the issue. Never
 *  throws — a rejected trigger is surfaced as a notice on the thread. */
export async function triggerPlanMode(
  env: WorkerEnv,
  db: D1Client,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  issue: Issue,
  identity: WorkspaceIdentity,
  command: PlanCommand,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<AgentSession | null> {
  try {
    // Triggers carry no agent choice — reuse the issue's most recent lane
    // agent (so a revision stays with the planner), else the repo default.
    const [previous] = await stub.listAgentSessions({
      issueId: issue.id,
      limit: 1,
    });
    // PILE-321 — triggered lanes inherit the team's defaultRepo too, so a
    // /plan comment or label on a repo-less issue plans against the repo.
    const target = await inheritTeamDefaultRepo(
      db,
      stub,
      organizationId,
      issue,
      identity.id
    );
    const { agentId, model } = await resolveDispatchAgent(
      env,
      db,
      organizationId,
      target,
      { agentId: previous?.agentId }
    );
    const options = await planLaneOptions(
      stub,
      target,
      command.kind,
      command.kind === "plan" ? command.feedback : null
    );
    const providerConfig = await loadProviderConfig(env, stub, agentId);
    const session = await dispatchAgent(
      resolveAgentEnv(env, providerConfig ?? undefined),
      agentId,
      organizationId,
      target,
      identity,
      model,
      ctx,
      {
        instructions: options.instructions,
        extraEnv: options.extraEnv,
        purpose: options.purpose ?? undefined,
        skipQueue: options.skipQueue,
      }
    );
    await notePlanSource(stub, session, options.plan);
    return session;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await stub
      .createComment({
        issueId: issue.id,
        body: `Plan mode: could not dispatch ${command.kind === "plan" ? "a plan lane" : "a build lane from the plan"} — ${reason}`,
        externalAuthor: PLAN_NOTICE_SOURCE,
        externalSource: PLAN_NOTICE_SOURCE,
      })
      .catch(() => null);
    return null;
  }
}

function splitLabelIds(labelIds: string | null | undefined): string[] {
  return (labelIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Label trigger: newly adding the `plan` label dispatches a plan lane when
 *  the issue has no live lane. Never throws. */
export async function triggerPlanLabel(
  env: WorkerEnv,
  db: D1Client,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  previousLabelIds: string | null | undefined,
  issue: Issue,
  identity: WorkspaceIdentity,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<AgentSession | null> {
  const before = new Set(splitLabelIds(previousLabelIds));
  const added = splitLabelIds(issue.labelIds).filter((id) => !before.has(id));
  if (added.length === 0) return null;
  try {
    const labels = await Promise.all(
      added.map((id) => getLabel(db, organizationId, id))
    );
    const planLabel = labels.some(
      (label) => label?.name.trim().toLowerCase() === PLAN_LABEL_NAME
    );
    if (!planLabel) return null;
    if (await stub.getActiveAgentSessionForIssue(issue.id)) return null;
    return await triggerPlanMode(
      env,
      db,
      stub,
      organizationId,
      issue,
      identity,
      { kind: "plan", feedback: null },
      ctx
    );
  } catch (err) {
    console.error("plan label trigger failed", {
      issueId: issue.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

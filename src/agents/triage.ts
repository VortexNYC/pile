// PILE-282 — triage lane: on issue.created, a team-configured agent answers
// common questions, picks labels, links duplicate/similar issues (from the
// issue.similar search) and drafts an implementation plan. Pile owns the
// candidate set and applies the report — the agent only judges.

import { z } from "zod";

import { createD1 } from "../global/db.js";
import { getTeamById } from "../global/teams.js";
import { listLabels } from "../global/workspace-entities.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import { dispatchAgent } from "./index.js";

export const TRIAGE_PURPOSE = "triage";

const SIMILAR_CANDIDATE_LIMIT = 8;
const MAX_LINKS = 5;
const MAX_LABELS = 5;

export interface TriageCandidate {
  identifier: string;
  title: string;
  status: string;
}

export interface TriageIssueShape {
  identifier?: string | null;
  title: string;
  description?: string | null;
}

export const triageReportSchema = z.object({
  answer: z.string().nullish(),
  labels: z.array(z.string()).default([]),
  duplicates: z.array(z.string()).default([]),
  similar: z.array(z.string()).default([]),
  plan: z.string().nullish(),
});

export type TriageReport = z.infer<typeof triageReportSchema>;

export function buildTriageInstructions(
  issue: TriageIssueShape,
  candidates: TriageCandidate[],
  labelNames: string[]
): string {
  return [
    "You are the triage lane for a newly created issue — do NOT implement anything, clone repositories, or open pull requests.",
    `Issue${issue.identifier ? ` ${issue.identifier}` : ""}: ${issue.title}`,
    issue.description?.trim()
      ? `Description:\n${issue.description.trim()}`
      : "Description: (empty)",
    "",
    "Similar existing issues (from the workspace similarity search, best first):",
    candidates.length > 0
      ? candidates
          .map((c) => `- ${c.identifier} [${c.status}] ${c.title}`)
          .join("\n")
      : "- (none)",
    "",
    "Available labels:",
    labelNames.length > 0
      ? labelNames.map((n) => `- ${n}`).join("\n")
      : "- (none)",
    "",
    "Tasks:",
    "1. answer: if the issue is a question you can answer from the ticket and the similar issues, answer it; otherwise null.",
    "2. labels: pick up to 5 labels from the available list that apply. Never invent labels.",
    "3. duplicates: identifiers from the similar list that describe the same problem.",
    "4. similar: identifiers from the similar list that are related but not duplicates.",
    "5. plan: a short markdown implementation plan (steps, likely touch points, open questions); null if not actionable.",
    "",
    "End your final message with exactly one fenced ```json block of this shape:",
    '{"answer": string | null, "labels": string[], "duplicates": string[], "similar": string[], "plan": string | null}',
  ].join("\n");
}

const FENCED_JSON = /```(?:json)?\s*\n([\s\S]*?)```/g;

function parseReportCandidate(text: string): TriageReport | null {
  try {
    const parsed = triageReportSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function textSources(result: string): string[] {
  const sources = [result];
  // Headless runners report a JSON envelope; the agent's prose lives in its
  // string fields with escaped newlines.
  try {
    const envelope: unknown = JSON.parse(result);
    if (envelope && typeof envelope === "object") {
      for (const value of Object.values(envelope)) {
        if (typeof value === "string") sources.push(value);
      }
    }
  } catch {
    // plain-text result
  }
  return sources;
}

/** Extracts the triage report from a lane result: the last fenced json block,
 *  or the whole result when it is the bare report object. */
export function parseTriageReport(
  result: string | null | undefined
): TriageReport | null {
  if (!result?.trim()) return null;
  for (const source of textSources(result)) {
    const blocks = [...source.matchAll(FENCED_JSON)].map((m) => m[1] ?? "");
    for (const block of blocks.toReversed()) {
      const report = parseReportCandidate(block.trim());
      if (report) return report;
    }
  }
  return parseReportCandidate(result.trim());
}

export interface TriagePlan {
  labelIds: string[];
  addedLabelNames: string[];
  duplicates: string[];
  similar: string[];
}

/** Resolves a report against the workspace: labels must exist (matched
 *  case-insensitively), links are de-duplicated, capped, and never self. */
export function planTriageApplication(
  report: TriageReport,
  issue: Pick<Issue, "identifier" | "labelIds">,
  labels: Array<{ id: string; name: string }>
): TriagePlan {
  const existing = (issue.labelIds ?? "").split(",").filter(Boolean);
  const byName = new Map(labels.map((l) => [l.name.trim().toLowerCase(), l]));
  const labelIds = [...existing];
  const addedLabelNames: string[] = [];
  for (const name of report.labels.slice(0, MAX_LABELS)) {
    const label = byName.get(name.trim().toLowerCase());
    if (!label || labelIds.includes(label.id)) continue;
    labelIds.push(label.id);
    addedLabelNames.push(label.name);
  }
  const seen = new Set(
    issue.identifier ? [issue.identifier.toLowerCase()] : []
  );
  const clean = (ids: string[]) => {
    const out: string[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push(id);
      if (out.length >= MAX_LINKS) break;
    }
    return out;
  };
  const duplicates = clean(report.duplicates);
  const similar = clean(report.similar);
  return { labelIds, addedLabelNames, duplicates, similar };
}

export function formatTriageComment(
  agentId: string,
  report: TriageReport,
  applied: { labels: string[]; duplicates: string[]; similar: string[] }
): string {
  const sections = [`Triage by ${agentId}`];
  if (report.answer?.trim())
    sections.push(`**Answer**\n\n${report.answer.trim()}`);
  if (applied.labels.length > 0)
    sections.push(`**Labels applied:** ${applied.labels.join(", ")}`);
  if (applied.duplicates.length > 0)
    sections.push(`**Possible duplicates:** ${applied.duplicates.join(", ")}`);
  if (applied.similar.length > 0)
    sections.push(`**Similar issues:** ${applied.similar.join(", ")}`);
  if (report.plan?.trim())
    sections.push(`**Draft implementation plan**\n\n${report.plan.trim()}`);
  if (sections.length === 1) sections.push("No findings.");
  return sections.join("\n\n");
}

/**
 * Starts the triage lane for a freshly created issue when its team has a
 * `triageAgentId`. Returns null when triage is not configured or not
 * applicable (drafts, closed issues).
 */
export async function dispatchTriageLane(
  env: WorkerEnv,
  organizationId: string,
  issue: Issue,
  actorId?: string
): Promise<AgentSession | null> {
  if (issue.isDraft || issue.status === "done" || issue.status === "canceled")
    return null;
  const d1 = createD1(env.D1);
  const team = await getTeamById(d1, issue.teamId, organizationId);
  if (!team?.triageAgentId) return null;

  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  const [similar, labels] = await Promise.all([
    stub.findSimilarIssues(issue.id, [issue.teamId], SIMILAR_CANDIDATE_LIMIT),
    listLabels(d1, organizationId),
  ]);
  const candidates: TriageCandidate[] = similar
    .filter((hit) => hit.issue.identifier)
    .map((hit) => ({
      identifier: hit.issue.identifier ?? "",
      title: hit.issue.title,
      status: hit.issue.status,
    }));
  const labelNames = labels
    .filter((l) => l.kind === "issue")
    .map((l) => l.name);

  const actor: WorkspaceIdentity = {
    id: actorId ?? team.ownerId,
    organizationId,
    type: "user",
    permissions: ["read"],
  };
  return dispatchAgent(
    env,
    team.triageAgentId,
    organizationId,
    { ...issue, repo: null, branch: null },
    actor,
    undefined,
    undefined,
    {
      instructions: buildTriageInstructions(issue, candidates, labelNames),
      purpose: TRIAGE_PURPOSE,
      skipQueue: true,
    }
  );
}

// PILE-283 — plan mode. A plan lane reads the repo and posts an
// implementation plan on the issue instead of code; `/plan <feedback>`
// revises it; `/implement_plan` (or dispatch mode "implement_plan") starts a
// build lane FROM the latest plan so lanes never code without an approved
// approach.

import type { Comment } from "../types/workspace.js";

export const PLAN_PURPOSE = "plan";
/** externalSource of the plan comment a completed plan lane posts. */
export const PLAN_COMMENT_SOURCE = "plan";
/** externalSource of plan-mode notices (rejected commands) — never a plan. */
export const PLAN_NOTICE_SOURCE = "plan-mode";
/** Adding a label with this name (case-insensitive) dispatches a plan lane. */
export const PLAN_LABEL_NAME = "plan";
/** Runner env: core.py skips commit/push when set, so a plan lane can read
 *  the repo but never opens a PR. */
export const PLAN_LANE_ENV: Record<string, string> = { PILE_LANE_MODE: "plan" };

export type PlanMode = "plan" | "implement_plan";

export type PlanCommand =
  | { kind: "plan"; feedback: string | null }
  | { kind: "implement_plan" };

const PLAN_COMMAND_PATTERN = /^\/plan(?:\s+([\s\S]*))?$/i;
const IMPLEMENT_COMMAND_PATTERN = /^\/implement[_-]plan\s*$/i;

/** `/plan [feedback]` or `/implement_plan` as the comment's first token. */
export function parsePlanCommand(body: string): PlanCommand | null {
  const trimmed = body.trim();
  const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? "";
  if (IMPLEMENT_COMMAND_PATTERN.test(firstLine)) {
    return { kind: "implement_plan" };
  }
  const match = PLAN_COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;
  const feedback = match[1]?.trim() ?? "";
  return { kind: "plan", feedback: feedback.length > 0 ? feedback : null };
}

/** Sandbox runners report a JSON envelope; the plan is the agent's output. */
export function extractPlanText(result: string | null | undefined): string {
  const text = result?.trim() ?? "";
  if (!text.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const tail = (parsed as Record<string, unknown>).output_tail;
      if (typeof tail === "string" && tail.trim().length > 0) {
        return tail.trim();
      }
    }
  } catch {
    // plain text that happens to start with "{"
  }
  return text;
}

export function formatPlanComment(agentId: string, plan: string): string {
  return [
    `Implementation plan by ${agentId}:`,
    "",
    plan,
    "",
    "---",
    "Reply `/plan <feedback>` to revise this plan, or `/implement_plan` to dispatch a build lane from it.",
  ].join("\n");
}

export interface PlanIssueShape {
  title: string;
  identifier?: string | null;
  repo?: string | null;
}

export function buildPlanInstructions(
  issue: PlanIssueShape,
  revision?: { plan: string; feedback: string | null }
): string {
  return [
    "You are running in PLAN MODE — do NOT implement anything. Do not edit files, commit, push, or open a pull request.",
    issue.repo
      ? `Read the code in ${issue.repo} as needed to ground the plan in the actual codebase.`
      : null,
    "Your final answer is an implementation plan for this ticket, in markdown:",
    "1. Approach — the chosen design and why (alternatives briefly)",
    "2. Changes — files/modules to touch and what changes in each",
    "3. Steps — ordered implementation steps",
    "4. Verification — tests and checks that prove it works",
    "5. Risks and open questions for the reviewer",
    ...(revision
      ? [
          "",
          "Revise the previous plan below.",
          revision.feedback
            ? `Requested changes:\n${revision.feedback}`
            : "No specific feedback was given — tighten and correct it.",
          "",
          "Previous plan:",
          revision.plan,
        ]
      : []),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildImplementPlanInstructions(plan: string): string {
  return [
    "Implement this ticket by following the APPROVED implementation plan below.",
    "Stay within the plan; if you must deviate, explain why in the PR description.",
    "",
    "Approved plan:",
    plan,
  ].join("\n");
}

/** Newest plan comment on the thread — the one `/implement_plan` builds. */
export function findLatestPlanComment(
  comments: ReadonlyArray<
    Pick<Comment, "id" | "externalSource" | "externalId" | "createdAt">
  >
): (typeof comments)[number] | null {
  let latest: (typeof comments)[number] | null = null;
  for (const comment of comments) {
    if (comment.externalSource !== PLAN_COMMENT_SOURCE) continue;
    if (!latest || comment.createdAt >= latest.createdAt) latest = comment;
  }
  return latest;
}

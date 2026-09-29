// VTX-209 — dispatch preflight: deterministic readiness heuristics plus the
// planner-critique prompt. The checks are provider-agnostic on purpose — a
// thin ticket fails every agent the same way, so the gate lives at the
// handoff (Pile's boundary), not inside any agent we don't control.

export interface DispatchReadiness {
  ready: boolean;
  missing: string[];
}

export interface PreflightIssueShape {
  title: string;
  description?: string | null;
  repo?: string | null;
}

const MIN_DESCRIPTION_LENGTH = 120;

const CODE_TASK_PATTERN =
  /\b(fix|bug|implement|add|build|create|refactor|update|remove|delete|migrate|endpoint|component|test|api|route|function|deploy)\b/i;

const ACCEPTANCE_PATTERN =
  /\b(acceptance|accept|verify|verified|should|expect|expected|criteria|requirement|must|done when|test that|ensure)\b/i;

const PLACEHOLDER_PATTERN =
  /\b(tbd|to be determined|todo|fill.?in|placeholder|whatever|something)\b|\?\?\?/i;

/**
 * Deterministic ticket-readiness check. Returns the list of gaps a lane would
 * trip over; `ready` is true when nothing obvious is missing. Heuristics are
 * advisory — dispatch is never blocked on them.
 */
export function evaluateDispatchReadiness(
  issue: PreflightIssueShape
): DispatchReadiness {
  const missing: string[] = [];
  const description = issue.description?.trim() ?? "";
  const text = `${issue.title}\n${description}`;

  if (description.length === 0) {
    missing.push("description is empty");
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    missing.push("description is too thin to act on autonomously");
  }

  if (CODE_TASK_PATTERN.test(text) && !issue.repo) {
    missing.push("task implies code changes but no repository is attached");
  }

  if (!ACCEPTANCE_PATTERN.test(text)) {
    missing.push("no acceptance criteria or expected outcome stated");
  }

  if (PLACEHOLDER_PATTERN.test(text)) {
    missing.push("placeholder language suggests the spec is unfinished");
  }

  return { ready: missing.length === 0, missing };
}

/**
 * Prompt for a planner-critique lane (`preflight` purpose): repo-less session
 * on the same target provider, whose job is to find what a lane would need
 * clarified before implementation. Its report lands on the issue thread when
 * the session terminates.
 */
export function buildPreflightCritiqueInstructions(
  issue: PreflightIssueShape
): string {
  return [
    "You are running a dispatch preflight — do NOT implement anything.",
    "Evaluate whether this ticket is specific enough for an autonomous agent to complete end-to-end without human help.",
    issue.repo ? `Target repository: ${issue.repo} (do not clone it).` : null,
    "",
    "IMPORTANT: never block waiting for input. If the ticket is ambiguous, do not ask — record the questions in your report and finish.",
    "Report back:",
    "1. READY or NOT READY verdict in the first line",
    "2. Missing or ambiguous details a lane would need answered",
    "3. Concrete clarifying questions for the reporter (numbered)",
    "If the ticket is genuinely ready, say READY and explain why briefly.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

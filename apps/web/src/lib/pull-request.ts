// Mirrors ISSUE_PR_STATES in src/types/workspace.ts — the API types prState
// as a plain string, so the console narrows it here.
const PR_STATES = ["draft", "open", "merged", "closed"] as const;
type PrState = (typeof PR_STATES)[number];
type PrChipVariant = "green" | "neutral" | "purple" | "red";
type CheckState = "success" | "failure" | "pending" | "unknown";

export interface IssuePrFields {
  prUrl: string | null;
  prState: string | null;
  prCheckState: string | null;
}

export interface PrChipModel {
  state: PrState | null;
  label: string;
  variant: PrChipVariant;
  ref: string | null;
  href: string | null;
  check: CheckState | null;
  checkLabel: string | null;
}

const PR_STATE_LABELS: Record<PrState, string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

const PR_STATE_VARIANTS: Record<PrState, PrChipVariant> = {
  draft: "neutral",
  open: "green",
  merged: "purple",
  closed: "red",
};

const CHECK_LABELS: Record<CheckState, string> = {
  success: "CI passing",
  failure: "CI failing",
  pending: "CI running",
  unknown: "CI status unknown",
};

const PR_HISTORY_FIELDS = new Set(["pr_url", "pr_state", "pr_check_state"]);

function isPrState(value: string | null): value is PrState {
  return value !== null && (PR_STATES as readonly string[]).includes(value);
}

function toCheckState(value: string | null): CheckState | null {
  if (value === null || value.length === 0) return null;
  return value === "success" || value === "failure" || value === "pending"
    ? value
    : "unknown";
}

function httpUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** `#123` for GitHub pulls, `!123` for GitLab merge requests. */
export function prRef(prUrl: string | null): string | null {
  const url = httpUrl(prUrl);
  if (!url) return null;
  const github = /\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (github) return `#${github[1]}`;
  const gitlab = /\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (gitlab) return `!${gitlab[1]}`;
  return null;
}

/** Badge model for an issue's linked PR, or null when nothing is linked. */
export function prChip(issue: IssuePrFields): PrChipModel | null {
  const href = httpUrl(issue.prUrl)?.toString() ?? null;
  const state = isPrState(issue.prState) ? issue.prState : null;
  if (!href && !state) return null;
  const check = toCheckState(issue.prCheckState);
  return {
    state,
    label: state ? PR_STATE_LABELS[state] : "Linked",
    variant: state ? PR_STATE_VARIANTS[state] : "neutral",
    ref: prRef(href),
    href,
    check,
    checkLabel: check ? CHECK_LABELS[check] : null,
  };
}

/** PR linkage history rows render as the chip, not as activity text. */
export function isPrHistoryField(field: string): boolean {
  return PR_HISTORY_FIELDS.has(field);
}

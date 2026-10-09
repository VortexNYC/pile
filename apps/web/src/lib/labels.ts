import type { paths } from "./api";

type IssueResponse =
  paths["/workspaces/{organizationId}/issues/{id}"]["get"]["responses"][200]["content"]["application/json"];
export type IssueStatus = IssueResponse["status"];
export type IssuePriority = IssueResponse["priority"];

type TicketResponse =
  paths["/workspaces/{organizationId}/support/tickets/{ticketId}"]["get"]["responses"][200]["content"]["application/json"]["ticket"];
export type TicketStatus = TicketResponse["status"];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  triage: "Needs review",
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  todo: "Open",
  snoozed: "Snoozed",
  done: "Resolved",
};

export const ISSUE_STATUSES = Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[];
export const PRIORITIES = Object.keys(PRIORITY_LABELS) as IssuePriority[];
export const TICKET_STATUSES = Object.keys(
  TICKET_STATUS_LABELS
) as TicketStatus[];

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && value in ISSUE_STATUS_LABELS;
}

export function isPriority(value: unknown): value is IssuePriority {
  return typeof value === "string" && value in PRIORITY_LABELS;
}

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && value in TICKET_STATUS_LABELS;
}

type BadgeVariant = "neutral" | "blue" | "orange" | "green" | "red" | "purple";

export function issueStatusVariant(status: IssueStatus): BadgeVariant {
  switch (status) {
    case "triage":
      return "purple";
    case "in_progress":
      return "blue";
    case "done":
      return "green";
    case "canceled":
      return "red";
    default:
      return "neutral";
  }
}

export function priorityVariant(priority: IssuePriority): BadgeVariant {
  switch (priority) {
    case "urgent":
      return "red";
    case "high":
      return "orange";
    default:
      return "neutral";
  }
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 2_592_000)
    return relative.format(Math.round(seconds / 86_400), "day");
  return new Date(then).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const NOTIFICATION_LABELS: Record<string, string> = {
  issue_assigned: "You were assigned an issue",
  issue_mentioned: "You were mentioned",
  comment_mentioned: "You were mentioned in a comment",
  issue_comment: "New comment on an issue",
  issue_status_changed: "Issue status changed",
};

export function notificationLabel(type: string): string {
  const known = NOTIFICATION_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_.-]+/g, " ").trim();
  return words.length > 0
    ? words.charAt(0).toUpperCase() + words.slice(1)
    : "Notification";
}

/** Flatten block-format document content to readable text. */
export function documentText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "text" && typeof value === "string") parts.push(value);
      else if (typeof value === "object") visit(value);
    }
  };
  visit(content);
  return parts.join("\n");
}

/** Lowercase, dash-separated workspace slug derived from a name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

type SessionResponse =
  paths["/workspaces/{organizationId}/agent/sessions"]["get"]["responses"][200]["content"]["application/json"]["sessions"][number];
export type SessionStatus = SessionResponse["status"];
export type SessionDerivedStatus = NonNullable<
  SessionResponse["derivedStatus"]
>;

export function sessionStatusVariant(status: SessionStatus): BadgeVariant {
  switch (status) {
    case "running":
      return "blue";
    case "waiting":
      return "purple";
    case "completed":
      return "green";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

export function derivedStatusVariant(
  derived: SessionDerivedStatus | null | undefined
): BadgeVariant | null {
  if (derived === "stalled") return "orange";
  if (derived === "needs_input") return "purple";
  return null;
}

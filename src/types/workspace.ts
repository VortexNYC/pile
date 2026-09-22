import type { InferSelectModel } from "drizzle-orm";

import type { FilterCondition } from "../workspace/filter.js";
import { workspaceAgentSessions } from "../workspace/schema.js";
import type { Id, Timestamp } from "./index.js";

export const AGENT_SESSION_STATUSES = [
  "created",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export type AgentSession = InferSelectModel<typeof workspaceAgentSessions>;

export interface AgentSessionResult {
  status: AgentSessionStatus;
  result?: string | null;
  url?: string | null;
  providerSessionId?: string | null;
  prUrl?: string | null;
  prState?: string | null;
  branch?: string | null;
}

export interface GitIdentity {
  id: string;
  organizationId: string;
  repo: string;
  name: string;
  email: string;
  githubUsername: string | null;
  signingKeyRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ISSUE_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_RESOLUTIONS = [
  "duplicate",
  "not_planned",
  "intended_behavior",
  "not_reproducible",
  "obsolete",
  "resolved",
] as const;
export type IssueResolution = (typeof ISSUE_RESOLUTIONS)[number];

export interface IssueInput {
  id?: Id;
  externalRef?: string | null;
  teamId?: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  resolution?: IssueResolution | null;
  parentId?: string | null;
  subIssueSortOrder?: number | null;
  estimate?: number | null;
  isDraft?: boolean;
  templateId?: string;
  snoozedUntil?: string | null;
  assigneeId?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  labelIds?: string | null;
  repo?: string;
  branch?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface IssueCursor {
  createdAt: Timestamp;
  id: Id;
}

export interface ListIssuesArgs {
  limit?: number;
  cursor?: IssueCursor;
  teamId?: string;
  teamIds?: string[];
  status?: IssueStatus;
  priority?: IssuePriority;
  parentId?: string | null;
  hasParent?: boolean;
  isParent?: boolean;
  isDraft?: boolean;
  hideSnoozed?: boolean;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  labelId?: string;
  search?: string;
  filter?: FilterCondition;
  externalRef?: string;
}

export interface Issue {
  id: Id;
  organizationId: Id;
  externalRef: string | null;
  teamId: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  resolution: IssueResolution | null;
  parentId: Id | null;
  subIssueSortOrder: number | null;
  estimate: number | null;
  isDraft: boolean;
  snoozedUntil: string | null;
  assigneeId: Id | null;
  projectId: Id | null;
  cycleId: Id | null;
  labelIds: string | null;
  number: number | null;
  identifier: string | null;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  prState: string | null;
  prCheckState: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Comment {
  id: Id;
  organizationId: Id;
  issueId: Id | null;
  documentId: Id | null;
  authorId: Id | null;
  body: string;
  internal: boolean;
  externalId: string | null;
  externalSource: string | null;
  externalAuthor: string | null;
  resolvedAt: Timestamp | null;
  resolvedById: Id | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type RealtimeEvent =
  | {
      type: "connected";
      organizationId: string;
    }
  | {
      type: "issue.created";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "issue.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "pr.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "issue.deleted";
      organizationId: string;
      issueId: Id;
    }
  | {
      type: "comment.created";
      organizationId: string;
      issue: Issue;
      comment: Comment;
    }
  | {
      type: "comment.updated";
      organizationId: string;
      issue: Issue;
      comment: Comment;
    }
  | {
      type: "comment.deleted";
      organizationId: string;
      issueId: Id;
      commentId: Id;
    }
  | {
      type: "document.updated";
      organizationId: string;
      documentId: Id;
    }
  | {
      type: "document.deleted";
      organizationId: string;
      documentId: Id;
    }
  | {
      type: "draft.created";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "draft.updated";
      organizationId: string;
      issue: Issue;
    }
  | {
      type: "draft.deleted";
      organizationId: string;
      issueId: Id;
    }
  | {
      type: "agent_session.created";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.updated";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.completed";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.failed";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "agent_session.canceled";
      organizationId: string;
      session: AgentSession;
      issue: Issue;
    }
  | {
      type: "support_ticket.created";
      organizationId: string;
      ticketId: Id;
    }
  | {
      type: "support_ticket.updated";
      organizationId: string;
      ticketId: Id;
    }
  | {
      type: "support_ticket.message_created";
      organizationId: string;
      ticketId: Id;
      messageId: Id;
    }
  | {
      type: "support_ticket.note_created";
      organizationId: string;
      ticketId: Id;
      noteId: Id;
    };

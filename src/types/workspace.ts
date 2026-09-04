import type { FilterCondition } from "../workspace/filter.js";
import type { Id, Timestamp } from "./index.js";

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
  teamId?: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  resolution?: IssueResolution | null;
  parentId?: string | null;
  subIssueSortOrder?: number | null;
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
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  labelId?: string;
  search?: string;
  filter?: FilterCondition;
}

export interface Issue {
  id: Id;
  organizationId: Id;
  teamId: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  resolution: IssueResolution | null;
  parentId: Id | null;
  subIssueSortOrder: number | null;
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
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Comment {
  id: Id;
  organizationId: Id;
  issueId: Id;
  authorId: Id | null;
  body: string;
  externalId: string | null;
  externalSource: string | null;
  externalAuthor: string | null;
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
    };

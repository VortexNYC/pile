import type { FilterCondition } from "../workspace/filter.js";
import type { Id, Timestamp } from "./index.js";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "done"
  | "canceled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueInput {
  id?: Id;
  teamId?: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
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
    };

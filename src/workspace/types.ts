import type { Id, Timestamp } from "../types/index.js";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "done"
  | "canceled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueInput {
  id?: Id;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  labelIds?: string;
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
  status?: IssueStatus;
  priority?: IssuePriority;
}

export interface Issue {
  id: Id;
  workspaceId: Id;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: Id | null;
  projectId: Id | null;
  cycleId: Id | null;
  labelIds: string | null;
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
      workspaceId: string;
    }
  | {
      type: "issue.created";
      workspaceId: string;
      issue: Issue;
    }
  | {
      type: "issue.updated";
      workspaceId: string;
      issue: Issue;
    }
  | {
      type: "pr.updated";
      workspaceId: string;
      issue: Issue;
    };

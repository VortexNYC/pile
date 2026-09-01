export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "done"
  | "canceled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueInput {
  id?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

export interface IssueCursor {
  createdAt: string;
  id: string;
}

export interface ListIssuesArgs {
  limit?: number;
  cursor?: IssueCursor;
  status?: IssueStatus;
  priority?: IssuePriority;
}

export interface Issue {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  projectId: string | null;
  cycleId: string | null;
  labelIds: string | null;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  prState: string | null;
  createdAt: string;
  updatedAt: string;
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

export type IssueStatus = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface IssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string;
  projectId?: string;
  cycleId?: string;
  labelIds?: string;
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
  createdAt: string;
  updatedAt: string;
}

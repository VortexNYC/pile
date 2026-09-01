import type { DurableObjectStub } from "@cloudflare/workers-types";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "done"
  | "canceled";
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
  repo?: string;
  branch?: string;
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

export interface WorkspaceDurableObjectStub extends DurableObjectStub {
  createIssue(input: IssueInput): Promise<Issue>;
  getIssue(id: string): Promise<Issue | undefined>;
  getIssueByBranch(repo: string, branch: string): Promise<Issue | undefined>;
  listIssues(): Promise<Issue[]>;
  updateIssue(
    id: string,
    patch: Partial<IssueInput>
  ): Promise<Issue | undefined>;
  updatePrState(
    repo: string,
    branch: string,
    prUrl: string,
    prState: string
  ): Promise<Issue | undefined>;
}

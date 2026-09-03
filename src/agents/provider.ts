import type { Issue } from "../types/workspace.js";

export interface AgentSession {
  id: string;
  agentId: string;
  issueId: string;
  status: string;
  result?: string;
  url?: string;
}

export interface AgentProvider {
  id: string;
  dispatch(
    workspaceId: string,
    issue: Issue,
    model?: string
  ): Promise<AgentSession>;
  poll(sessionId: string): Promise<AgentSession>;
}

import type { Issue } from "../types/workspace.js";

export interface AgentProviderSession {
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
    organizationId: string,
    issue: Issue,
    model?: string
  ): Promise<AgentProviderSession>;
  poll(sessionId: string): Promise<AgentProviderSession>;
}

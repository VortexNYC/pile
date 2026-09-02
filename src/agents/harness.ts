import type { Issue } from "../workspace/types.js";
import type { AgentProvider, AgentSession } from "./provider.js";

export interface MockAgentProviderOptions {
  dispatch?: (
    workspaceId: string,
    issue: Issue,
    model?: string
  ) => AgentSession | Promise<AgentSession>;
  poll?: (sessionId: string) => AgentSession | Promise<AgentSession>;
}

export class MockAgentProvider implements AgentProvider {
  readonly id: string;
  private options: MockAgentProviderOptions;

  constructor(id: string, options: MockAgentProviderOptions = {}) {
    this.id = id;
    this.options = options;
  }

  async dispatch(
    workspaceId: string,
    issue: Issue,
    model?: string
  ): Promise<AgentSession> {
    if (this.options.dispatch) {
      return await this.options.dispatch(workspaceId, issue, model);
    }
    return {
      id: "mock-session",
      agentId: this.id,
      issueId: issue.id,
      status: "created",
    };
  }

  async poll(sessionId: string): Promise<AgentSession> {
    if (this.options.poll) {
      return await this.options.poll(sessionId);
    }
    return {
      id: sessionId,
      agentId: this.id,
      issueId: "",
      status: "completed",
      result: "mock-result",
    };
  }
}

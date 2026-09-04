import type { Issue } from "../types/workspace.js";
import type { AgentProvider, AgentProviderSession } from "./provider.js";

export interface MockAgentProviderOptions {
  dispatch?: (
    organizationId: string,
    issue: Issue,
    model?: string
  ) => AgentProviderSession | Promise<AgentProviderSession>;
  poll?: (
    sessionId: string
  ) => AgentProviderSession | Promise<AgentProviderSession>;
}

export class MockAgentProvider implements AgentProvider {
  readonly id: string;
  private options: MockAgentProviderOptions;

  constructor(id: string, options: MockAgentProviderOptions = {}) {
    this.id = id;
    this.options = options;
  }

  async dispatch(
    organizationId: string,
    issue: Issue,
    model?: string
  ): Promise<AgentProviderSession> {
    if (this.options.dispatch) {
      return await this.options.dispatch(organizationId, issue, model);
    }
    return {
      id: "mock-session",
      agentId: this.id,
      issueId: issue.id,
      status: "created",
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
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

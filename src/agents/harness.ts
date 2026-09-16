import type { Issue } from "../types/workspace.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

export interface MockAgentProviderOptions {
  dispatch?: (
    organizationId: string,
    issue: Issue,
    model?: string,
    sessionContext?: AgentDispatchContext
  ) => AgentProviderSession | Promise<AgentProviderSession>;
  poll?: (
    sessionId: string
  ) => AgentProviderSession | Promise<AgentProviderSession>;
  getState?: (
    providerSessionId: string,
    trackerSessionId: string
  ) => AgentProviderState | Promise<AgentProviderState | null> | null;
  health?: () => AgentProviderHealth | Promise<AgentProviderHealth>;
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
    model?: string,
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession> {
    if (this.options.dispatch) {
      return await this.options.dispatch(
        organizationId,
        issue,
        model,
        sessionContext
      );
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

  async getState(
    providerSessionId: string,
    trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    if (this.options.getState) {
      return await this.options.getState(providerSessionId, trackerSessionId);
    }
    return null;
  }

  async health(): Promise<AgentProviderHealth> {
    if (this.options.health) return await this.options.health();
    return { ok: true };
  }
}

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
  cancel?: (sessionId: string) => void | Promise<void>;
}

export class MockAgentProvider implements AgentProvider {
  readonly id: string;
  readonly cancel?: (sessionId: string) => Promise<void>;
  private options: MockAgentProviderOptions;

  constructor(id: string, options: MockAgentProviderOptions = {}) {
    this.id = id;
    this.options = options;
    if (options.cancel) {
      const cancel = options.cancel;
      this.cancel = async (sessionId: string) => {
        await cancel(sessionId);
      };
    }
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

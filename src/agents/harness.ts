import type { GitIdentity, Issue } from "../types/workspace.js";
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
  sendPrompt?: (
    trackerSessionId: string,
    prompt: string,
    issue: Issue,
    gitIdentity?: GitIdentity | null
  ) => boolean | Promise<boolean>;
  health?: () => AgentProviderHealth | Promise<AgentProviderHealth>;
  latestElicitation?: (
    providerSessionId: string
  ) => string | Promise<string | null> | null;
  cancel?: (sessionId: string) => void | Promise<void>;
  keepsTerminalSandbox?: boolean;
}

export class MockAgentProvider implements AgentProvider {
  readonly id: string;
  readonly keepsTerminalSandbox: boolean;
  cancel?: (sessionId: string) => Promise<void>;
  private options: MockAgentProviderOptions;

  constructor(id: string, options: MockAgentProviderOptions = {}) {
    this.id = id;
    this.options = options;
    this.keepsTerminalSandbox = options.keepsTerminalSandbox === true;
    const cancel = options.cancel;
    if (cancel) {
      this.cancel = async (sessionId) => cancel(sessionId);
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

  async sendPrompt(
    trackerSessionId: string,
    prompt: string,
    issue: Issue,
    gitIdentity?: GitIdentity | null
  ): Promise<boolean> {
    if (this.options.sendPrompt) {
      return await this.options.sendPrompt(
        trackerSessionId,
        prompt,
        issue,
        gitIdentity
      );
    }
    return false;
  }

  async health(): Promise<AgentProviderHealth> {
    if (this.options.health) return await this.options.health();
    return { ok: true };
  }

  async latestElicitation(providerSessionId: string): Promise<string | null> {
    if (this.options.latestElicitation) {
      return await this.options.latestElicitation(providerSessionId);
    }
    return null;
  }
}

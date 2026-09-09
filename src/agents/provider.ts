import type { AgentSessionResult, Issue } from "../types/workspace.js";

export interface AgentProviderSession extends AgentSessionResult {
  id: string;
  agentId: string;
  /** Issue id is set when dispatch creates a session; polls may omit it. */
  issueId?: string;
}

export interface AgentDispatchContext {
  /** Tracker-side session id, pre-created so providers can hand it to the
   *  remote agent for write-back. */
  sessionId: string;
}

export interface AgentProvider {
  id: string;
  dispatch(
    organizationId: string,
    issue: Issue,
    model?: string,
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession>;
  poll(sessionId: string): Promise<AgentProviderSession>;
  /**
   * Terminate the provider-side run. Optional — providers that can't cancel
   * remotely simply omit this and the tracker marks the session canceled
   * locally.
   */
  cancel?(sessionId: string): Promise<void>;
}

import type {
  AgentSessionResult,
  GitIdentity,
  Issue,
} from "../types/workspace.js";

export interface AgentProviderSession extends AgentSessionResult {
  id: string;
  agentId: string;
  /** Issue id is set when dispatch creates a session; polls may omit it. */
  issueId?: string;
}

/** Optional structured state that a provider can return for live introspection
 *  by the workspace (e.g. raw provider session + compute sandbox details). */
export interface AgentProviderState {
  provider?: unknown;
  compute?: unknown;
}

export interface AgentDispatchContext {
  /** Tracker-side session id, pre-created so providers can hand it to the
   *  remote agent for write-back. */
  sessionId: string;
  /** Git identity for the target repository, if one is configured. */
  gitIdentity?: GitIdentity | null;
  /** Optional Worker execution context waitUntil for background work
   *  that must not block the HTTP response. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface AgentProviderHealth {
  ok: boolean;
  message?: string;
}

export async function probeUrl(
  url: string,
  init?: RequestInit
): Promise<AgentProviderHealth> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `${res.status} ${text.slice(0, 200)}` };
  }
  return { ok: true };
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
  /**
   * Optional live state for the provider and underlying compute. Used by the
   * session state endpoint to expose raw provider/compute details.
   */
  getState?(
    providerSessionId: string,
    trackerSessionId: string
  ): Promise<AgentProviderState | null>;
  /**
   * Optional credential/config probe. Must not start a session. Used by
   * POST /agent/providers/{agentId}/health so a bad token fails at save-time
   * rather than eight hours into a run.
   */
  health?(): Promise<AgentProviderHealth>;
  /**
   * Optional inbound webhook parser. Return null when the payload is not
   * for this provider. sessionId is the provider-side id.
   */
  parseWebhook?(
    body: unknown,
    headers: Headers
  ): { sessionId: string; session?: AgentProviderSession } | null;
}

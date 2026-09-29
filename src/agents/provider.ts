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

export interface DispatchComment {
  author: string;
  createdAt?: string | null;
  body: string;
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
  /** Recent issue comments, chronological — folded into the prompt so
   *  re-dispatches carry review feedback. */
  comments?: DispatchComment[];
  /** Scoped read-only Pile API credential minted for this dispatch, so the
   *  agent can fetch linked support tickets and capture artifacts. */
  pileApi?: { url: string; key: string };
  /** Extra operating rules for this dispatch, appended to the prompt's
   *  context section — lets an orchestrator pass constraints without
   *  posting an issue comment. */
  instructions?: string;
  /** Additional sandbox env vars (e.g. lane-DB connection strings from
   *  PILE-212 provisioning). Providers merge these into the runner env. */
  extraEnv?: Record<string, string>;
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
   * Deliver a follow-up prompt into a session whose sandbox is still alive
   * (kept after a terminal run for the resume window — PILE-210). Returns
   * true when the prompt was accepted by a live sandbox; false when the
   * sandbox is gone or busy and the caller should cold-dispatch instead.
   */
  sendPrompt?(
    trackerSessionId: string,
    prompt: string,
    issue: Issue,
    gitIdentity?: GitIdentity | null
  ): Promise<boolean>;
  /**
   * Optional live state for the provider and underlying compute. Used by the
   * session state endpoint to expose raw provider/compute details.
   */
  getState?(
    providerSessionId: string,
    trackerSessionId: string
  ): Promise<AgentProviderState | null>;
  /**
   * Optional: fetch the text of whatever the agent is currently asking, when
   * the lane is parked in `waiting` (VTX-209). Lets the elicitation surface
   * carry the actual question instead of a bare status string. Providers
   * without a message-history API omit it.
   */
  latestElicitation?(providerSessionId: string): Promise<string | null>;
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

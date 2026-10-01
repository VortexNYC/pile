// Per-session GitHub credentials for agent lanes. Every lane gets an
// installation token restricted to its issue's repository, and the token is
// bound to the session: re-minting revokes the previous one, and once the
// session is terminal the sweep revokes whatever the lane still holds. A
// compromised lane therefore holds at most one live, single-repo token that
// dies with the run instead of living out GitHub's ~1h TTL.
//
// Secondary repos (PILE-294) get their own single-repo token in a separate
// slot (`<sessionId>|<repo>`), so minting one never revokes the primary's and
// the reaper retires them together once the session is terminal.
import {
  getRepoScopedInstallationToken,
  revokeInstallationToken,
  type RepoScopedToken,
} from "../global/github-auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { decryptSecret, encryptSecret } from "./credentials.js";

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const SLOT_SEPARATOR = "|";

function laneTokenSlot(sessionId: string, secondaryRepo?: string): string {
  return secondaryRepo
    ? `${sessionId}${SLOT_SEPARATOR}${secondaryRepo.toLowerCase()}`
    : sessionId;
}

async function revokeEncrypted(
  env: WorkerEnv,
  encrypted: string
): Promise<boolean> {
  try {
    const token = await decryptSecret(env, encrypted);
    return token ? await revokeInstallationToken(token) : false;
  } catch (err) {
    // Best-effort: an unrevoked token still expires within the hour.
    console.error("lane github token revoke failed:", err);
    return false;
  }
}

export async function mintLaneGithubToken(
  env: WorkerEnv,
  organizationId: string,
  sessionId: string,
  repo: string,
  options?: { secondary?: boolean }
): Promise<RepoScopedToken | undefined> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return undefined;
  const minted = await getRepoScopedInstallationToken(env, owner, name);
  if (!minted) return undefined;
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  const previous = await stub.swapLaneGithubToken(
    laneTokenSlot(sessionId, options?.secondary ? repo : undefined),
    await encryptSecret(env, minted.token)
  );
  if (previous) await revokeEncrypted(env, previous);
  return minted;
}

export async function revokeLaneGithubToken(
  env: WorkerEnv,
  stub: WorkspaceStub,
  slot: string
): Promise<boolean> {
  const encrypted = await stub.takeLaneGithubToken(slot);
  if (!encrypted) return false;
  return revokeEncrypted(env, encrypted);
}

/** Revoke the tokens of every lane whose session is terminal (or gone). */
export async function reapLaneGithubTokens(
  env: WorkerEnv,
  stub: WorkspaceStub
): Promise<number> {
  let revoked = 0;
  for (const slot of await stub.listLaneGithubTokenSessions()) {
    const [sessionId] = slot.split(SLOT_SEPARATOR);
    const session = await stub.getAgentSession(sessionId);
    if (session && !TERMINAL_STATUSES.has(session.status)) continue;
    if (await revokeLaneGithubToken(env, stub, slot)) revoked++;
  }
  return revoked;
}

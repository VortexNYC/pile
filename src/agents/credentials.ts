import { sha256Hex } from "../global/crypto.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentProviderConfigRow } from "./daytona.js";

/**
 * At-rest encryption for workspace-scoped agent credentials.
 *
 * Provider tokens, compute API keys, and the provider config blob are stored
 * in workspace Durable Object SQLite. Before storage they are encrypted with
 * AES-256-GCM under a key derived from AGENT_SETTINGS_KEK, falling back to
 * BETTER_AUTH_SECRET (always present) so self-hosters need no extra secret.
 *
 * Ciphertext format: `enc:v1:<base64(iv)>:<base64(ciphertext)>`. Values
 * without the prefix are treated as legacy plaintext and returned as-is so
 * existing rows keep working until they're rewritten.
 */

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
/** Marker key inside a config blob signalling the real config is encrypted. */
const ENCRYPTED_CONFIG_KEY = "$encrypted";

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(buf instanceof Uint8Array ? buf.buffer : buf)
    )
  );
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function keyMaterial(env: WorkerEnv): string {
  const secret = env.AGENT_SETTINGS_KEK ?? env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("AGENT_SETTINGS_KEK or BETTER_AUTH_SECRET must be set");
  }
  return secret;
}

let cachedKey: Promise<CryptoKey> | null = null;

function getKey(env: WorkerEnv): Promise<CryptoKey> {
  // Key derivation is deterministic per deployment secret; cache the imported
  // key for the life of the isolate.
  cachedKey ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(keyMaterial(env)))
    .then((digest) =>
      crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ])
    );
  return cachedKey;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export async function encryptSecret(
  env: WorkerEnv,
  plaintext: string
): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${PREFIX}${b64encode(iv)}:${b64encode(ct)}`;
}

export async function decryptSecret(
  env: WorkerEnv,
  value: string | null | undefined
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;
  const [, , ivB64, ctB64] = value.split(":");
  const key = await getKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) },
    key,
    b64decode(ctB64)
  );
  return new TextDecoder().decode(pt);
}

/** Encrypt the sensitive fields of a provider config before DO storage. */
export async function encryptProviderConfigInput<
  T extends {
    token?: string | null;
    computeApiKey?: string | null;
    config?: Record<string, unknown> | null;
  },
>(env: WorkerEnv, input: T): Promise<T> {
  const out: T = { ...input };
  if (
    typeof out.token === "string" &&
    out.token !== "" &&
    !isEncrypted(out.token)
  ) {
    out.token = await encryptSecret(env, out.token);
  }
  if (
    typeof out.computeApiKey === "string" &&
    out.computeApiKey !== "" &&
    !isEncrypted(out.computeApiKey)
  ) {
    out.computeApiKey = await encryptSecret(env, out.computeApiKey);
  }
  if (out.config) {
    const configJson = JSON.stringify(out.config);
    if (!isEncrypted(configJson)) {
      // config carries non-secret fields (model, computeProvider) alongside
      // secrets (webhookSecret); encrypt the whole blob and mark it so readers
      // know to decrypt before parsing.
      const encrypted = await encryptSecret(env, configJson);
      out.config = { [ENCRYPTED_CONFIG_KEY]: encrypted } as T["config"];
    }
  }
  return out;
}

function configIsEncrypted(configJson: string | null | undefined): boolean {
  if (!configJson) return true;
  try {
    const parsed: unknown = JSON.parse(configJson);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)[ENCRYPTED_CONFIG_KEY] ===
        "string"
    );
  } catch {
    return false;
  }
}

function rowNeedsReencrypt(row: AgentProviderConfigRow): boolean {
  if (
    typeof row.token === "string" &&
    row.token !== "" &&
    !isEncrypted(row.token)
  )
    return true;
  if (
    typeof row.computeApiKey === "string" &&
    row.computeApiKey !== "" &&
    !isEncrypted(row.computeApiKey)
  )
    return true;
  return !configIsEncrypted(row.config);
}

/**
 * Read + decrypt a workspace's provider config, lazily upgrading any
 * legacy plaintext fields to encrypted storage on first read.
 */
export async function loadProviderConfig<
  T extends AgentProviderConfigRow & { agentId: string },
>(
  env: WorkerEnv,
  stub: {
    getAgentProviderConfig(agentId: string): Promise<T | null | undefined>;
    upsertAgentProviderConfig(input: {
      agentId: string;
      token?: string | null;
      computeApiKey?: string | null;
      config?: Record<string, unknown> | null;
    }): Promise<unknown>;
  },
  agentId: string
): Promise<T | null> {
  const row = await stub.getAgentProviderConfig(agentId);
  if (!row) return null;
  const decrypted = await decryptProviderConfigRow(env, row);
  if (decrypted && rowNeedsReencrypt(row)) {
    const encrypted = await encryptProviderConfigInput(env, {
      token: decrypted.token,
      computeApiKey: decrypted.computeApiKey,
      config: decrypted.config
        ? (JSON.parse(decrypted.config) as Record<string, unknown>)
        : null,
    });
    // Fire-and-forget upgrade; callers proceed with the decrypted row.
    void stub
      .upsertAgentProviderConfig({
        agentId,
        token: encrypted.token,
        computeApiKey: encrypted.computeApiKey,
        config: encrypted.config,
      })
      .catch((err) =>
        console.error("provider config re-encryption failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }
  return decrypted;
}

/** Decrypt a stored provider config row into its plaintext form. */
export async function decryptProviderConfigRow<
  T extends AgentProviderConfigRow,
>(env: WorkerEnv, row: T | null | undefined): Promise<T | null> {
  if (!row) return row ?? null;
  const out = { ...row };
  out.token = await decryptSecret(env, row.token);
  out.computeApiKey = await decryptSecret(env, row.computeApiKey);
  if (row.config) {
    try {
      const parsed: unknown = JSON.parse(row.config);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>)[ENCRYPTED_CONFIG_KEY] ===
          "string"
      ) {
        out.config = await decryptSecret(
          env,
          (parsed as Record<string, unknown>)[ENCRYPTED_CONFIG_KEY] as string
        );
      }
    } catch {
      // leave as-is; callers already guard malformed JSON
    }
  }
  return out;
}
/**
 * Per-session bearer token the runner uses to push log lines back to Pile.
 * Derived from the deployment dispatch secret — not stored anywhere, so it
 * can't leak via the sessions API, and it only authorizes appending logs to
 * the one session it was minted for.
 */
export async function agentLogToken(
  env: WorkerEnv,
  organizationId: string,
  sessionId: string
): Promise<string | null> {
  const secret = env.DISPATCH_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return sha256Hex(`agent-logs:${organizationId}:${sessionId}:${secret}`);
}

/**
 * Public base URL the runner calls back to for log ingest. Falls back to
 * BETTER_AUTH_URL (the product origin) when PUBLIC_API_URL isn't set.
 */
export function agentLogUrl(
  env: WorkerEnv,
  organizationId: string,
  sessionId: string
): string | null {
  const base = env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/workspaces/${organizationId}/agent/sessions/${sessionId}/logs`;
}

/**
 * Base URL for the runner's pnpm-store cache (GET/PUT keyed by lockfile hash
 * appended as a path segment). Same per-session token auth as agentLogUrl.
 */
export function agentCacheUrl(
  env: WorkerEnv,
  organizationId: string,
  sessionId: string
): string | null {
  const base = env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store`;
}

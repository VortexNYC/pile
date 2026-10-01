// PILE-285 — subscription credential pool. Lets sandbox-CLI lanes ride a
// Claude Code / Codex (ChatGPT) / Gemini subscription login instead of
// per-token API billing, with an ordered fallback list (e.g. two Claude Max
// seats, then an Anthropic API key). Entries can be scoped to lane purposes
// so only review/triage-tier lanes burn subscription quota.
//
// Probing is offline and never starts a session: it decodes the stored
// credential blob, reads its expiry, and reports whether the CLI can still
// use it as-is (`ok`), will refresh it itself on first call (`refreshable`),
// or is dead (`expired` / `invalid`).
import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { AgentProviderHealth } from "./provider.js";

export const CREDENTIAL_KINDS = [
  "claudeSubscription",
  "codexOAuth",
  "geminiOAuth",
  "anthropicApiKey",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

const MAX_POOL_ENTRIES = 16;
/** Treat tokens expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 60_000;

const poolEntrySchema = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  secret: z.string().min(1),
  label: z.string().min(1).optional(),
  /** Lane purposes this entry may serve (e.g. ["review", "triage"]).
   *  Omitted = every lane. */
  purposes: z.array(z.string().min(1)).optional(),
});

export const credentialPoolSchema = z
  .array(poolEntrySchema)
  .max(MAX_POOL_ENTRIES);

export type CredentialPoolEntry = z.infer<typeof poolEntrySchema>;

export type CredentialProbeStatus =
  | "ok"
  | "refreshable"
  | "expired"
  | "invalid";

export interface CredentialProbe {
  status: CredentialProbeStatus;
  /** ISO timestamp of the access-token expiry, when the blob carries one. */
  expiresAt?: string;
  message?: string;
}

export interface PoolCandidateReport {
  label: string;
  kind: CredentialKind;
  status: CredentialProbeStatus | "purpose-mismatch";
  message?: string;
}

export interface PoolSelection {
  entry: CredentialPoolEntry;
  label: string;
  probe: CredentialProbe;
  /** Entries passed over before the selected one, in pool order. */
  skipped: PoolCandidateReport[];
}

function poolError(message: string): VortexError {
  return new VortexError({ code: "CONFIG_ERROR", status: 500, message });
}

/** Parse the AGENT_CREDENTIAL_POOL JSON. Returns null when unset/empty. */
export function parseCredentialPool(
  raw: string | null | undefined
): CredentialPoolEntry[] | null {
  if (!raw || raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw poolError("AGENT_CREDENTIAL_POOL is not valid JSON");
  }
  const parsed = credentialPoolSchema.safeParse(value);
  if (!parsed.success) {
    throw poolError(
      `AGENT_CREDENTIAL_POOL is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "pool"}: ${i.message}`)
        .join("; ")}`
    );
  }
  return parsed.data.length > 0 ? parsed.data : null;
}

export function poolEntryLabel(
  entry: CredentialPoolEntry,
  index: number
): string {
  return entry.label ?? `${entry.kind}#${index}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Credential files may be stored raw or base64-encoded. */
export function decodeJsonSecret(
  secret: string
): Record<string, unknown> | null {
  const trimmed = secret.trim();
  const candidates = [trimmed];
  try {
    candidates.push(atob(trimmed));
  } catch {
    // not base64
  }
  for (const text of candidates) {
    try {
      const record = asRecord(JSON.parse(text));
      if (record) return record;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function decodeBase64Url(segment: string): string | null {
  try {
    const b64 = segment.replaceAll("-", "+").replaceAll("_", "/");
    return atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  } catch {
    return null;
  }
}

/** `exp` claim of a JWT in epoch ms, or null when not a decodable JWT. */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return null;
  try {
    const exp = asRecord(JSON.parse(payload))?.exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Epoch-ms timestamps, tolerating epoch seconds and ISO strings. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function expiryProbe(
  expiresAtMs: number | null,
  hasRefreshToken: boolean,
  now: number
): CredentialProbe {
  if (expiresAtMs === null) {
    return hasRefreshToken
      ? { status: "ok", message: "expiry unknown; refresh token present" }
      : { status: "ok", message: "expiry unknown" };
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  if (expiresAtMs - EXPIRY_SKEW_MS > now) return { status: "ok", expiresAt };
  return hasRefreshToken
    ? {
        status: "refreshable",
        expiresAt,
        message: "access token expired; CLI will refresh it on first call",
      }
    : {
        status: "expired",
        expiresAt,
        message: "access token expired and no refresh token is stored",
      };
}

function probeClaude(secret: string, now: number): CredentialProbe {
  const trimmed = secret.trim();
  if (trimmed.startsWith("sk-ant-api")) {
    return {
      status: "invalid",
      message:
        "Anthropic API key stored as claudeSubscription; use kind anthropicApiKey",
    };
  }
  // `claude setup-token` output: long-lived opaque OAuth token.
  if (trimmed.startsWith("sk-ant-oat")) return { status: "ok" };
  // `~/.claude/.credentials.json` from an interactive `claude /login`.
  const oauth = asRecord(decodeJsonSecret(trimmed)?.claudeAiOauth);
  if (!oauth || !nonEmptyString(oauth.accessToken)) {
    return {
      status: "invalid",
      message:
        "expected a `claude setup-token` token or ~/.claude/.credentials.json",
    };
  }
  return expiryProbe(
    toEpochMs(oauth.expiresAt),
    nonEmptyString(oauth.refreshToken) !== null,
    now
  );
}

/** codexRefreshDetect: read `~/.codex/auth.json` ChatGPT tokens. */
function probeCodex(secret: string, now: number): CredentialProbe {
  const auth = decodeJsonSecret(secret);
  if (!auth) {
    return { status: "invalid", message: "expected ~/.codex/auth.json" };
  }
  const tokens = asRecord(auth.tokens);
  const accessToken = nonEmptyString(tokens?.access_token);
  if (!accessToken) {
    return {
      status: "invalid",
      message: nonEmptyString(auth.OPENAI_API_KEY)
        ? "auth.json is API-key mode, not a ChatGPT login"
        : "auth.json has no ChatGPT tokens; run `codex login`",
    };
  }
  return expiryProbe(
    jwtExpiryMs(accessToken),
    nonEmptyString(tokens?.refresh_token) !== null,
    now
  );
}

/** `~/.gemini/oauth_creds.json` from a Gemini CLI Google login. */
function probeGemini(secret: string, now: number): CredentialProbe {
  const creds = decodeJsonSecret(secret);
  if (!creds || !nonEmptyString(creds.access_token)) {
    return {
      status: "invalid",
      message: "expected ~/.gemini/oauth_creds.json",
    };
  }
  return expiryProbe(
    toEpochMs(creds.expiry_date),
    nonEmptyString(creds.refresh_token) !== null,
    now
  );
}

/** subscriptionProbe — offline usability check for one pool entry. */
export function probeSubscriptionCredential(
  entry: CredentialPoolEntry,
  now: number = Date.now()
): CredentialProbe {
  switch (entry.kind) {
    case "claudeSubscription":
      return probeClaude(entry.secret, now);
    case "codexOAuth":
      return probeCodex(entry.secret, now);
    case "geminiOAuth":
      return probeGemini(entry.secret, now);
    case "anthropicApiKey":
      return entry.secret.trim().startsWith("sk-ant-")
        ? { status: "ok" }
        : { status: "invalid", message: "expected an sk-ant- API key" };
  }
}

function usable(probe: CredentialProbe): boolean {
  return probe.status === "ok" || probe.status === "refreshable";
}

function describe(reports: PoolCandidateReport[]): string {
  return reports
    .map(
      (r) =>
        `${r.label} (${r.kind}): ${r.status}${r.message ? ` — ${r.message}` : ""}`
    )
    .join("; ");
}

/** Pool entries a provider can consume, keeping their original index. */
export function poolEntriesForKinds(
  pool: CredentialPoolEntry[],
  kinds: readonly CredentialKind[]
): Array<{ entry: CredentialPoolEntry; index: number }> {
  return pool
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => kinds.includes(entry.kind));
}

/**
 * Walk the pool in order and return the first entry that accepts this lane
 * purpose and probes usable. Throws CONFIG_ERROR describing every candidate
 * when none qualify, so the dispatch failure says why.
 */
export function selectPoolCredential(
  pool: CredentialPoolEntry[],
  opts: {
    kinds: readonly CredentialKind[];
    purpose?: string | null;
    now?: number;
  }
): PoolSelection {
  const now = opts.now ?? Date.now();
  const skipped: PoolCandidateReport[] = [];
  for (const { entry, index } of poolEntriesForKinds(pool, opts.kinds)) {
    const label = poolEntryLabel(entry, index);
    if (
      entry.purposes &&
      !(opts.purpose && entry.purposes.includes(opts.purpose))
    ) {
      skipped.push({
        label,
        kind: entry.kind,
        status: "purpose-mismatch",
        message: `serves ${entry.purposes.join(", ")}; lane is ${opts.purpose ?? "default"}`,
      });
      continue;
    }
    const probe = probeSubscriptionCredential(entry, now);
    if (usable(probe)) return { entry, label, probe, skipped };
    skipped.push({
      label,
      kind: entry.kind,
      status: probe.status,
      message: probe.message,
    });
  }
  throw poolError(
    skipped.length > 0
      ? `No usable credential in pool: ${describe(skipped)}`
      : `Credential pool has no ${opts.kinds.join("/")} entries`
  );
}

/** Save-time health for the pool slice a provider consumes. */
export function poolHealth(
  pool: CredentialPoolEntry[],
  kinds: readonly CredentialKind[],
  now: number = Date.now()
): AgentProviderHealth {
  const reports: PoolCandidateReport[] = poolEntriesForKinds(pool, kinds).map(
    ({ entry, index }) => {
      const probe = probeSubscriptionCredential(entry, now);
      return {
        label: poolEntryLabel(entry, index),
        kind: entry.kind,
        status: probe.status,
        message: probe.expiresAt
          ? `${probe.message ? `${probe.message}, ` : ""}expires ${probe.expiresAt}`
          : probe.message,
      };
    }
  );
  if (reports.length === 0) {
    return {
      ok: false,
      message: `Credential pool has no ${kinds.join("/")} entries`,
    };
  }
  return {
    ok: reports.some((r) => r.status === "ok" || r.status === "refreshable"),
    message: describe(reports),
  };
}

/** Pool view safe to return from the API — secrets dropped. */
export function redactCredentialPool(
  value: unknown
): Array<Omit<CredentialPoolEntry, "secret">> | null {
  const parsed = credentialPoolSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    purposes: entry.purposes,
  }));
}

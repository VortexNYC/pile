import { z } from "zod";

import { effortModelsSchema } from "../agents/budget.js";
import type { AppEnv } from "../types/env.js";
import {
  getInstallationTokenForRepo,
  GITHUB_USER_AGENT,
} from "./github-auth.js";

const GITHUB_API = "https://api.github.com";

// Lane permission tiers (PILE-276). `disabled` < `restricted` < `enabled`.
//   push: disabled — runner never pushes or opens a PR; the lane token is
//                    minted contents:read.
//         restricted — runner pushes only the lane's feature branch (never the
//                    default branch, tags, or deletes); the write token never
//                    reaches the agent's env or the checkout's git config.
//         enabled — today's behavior.
//   shell: disabled — agent shell tool denied, env-var secrets stripped, and
//                    git hooks killed (the commit-time escape vector).
//          restricted — shell allowed, env-var secrets stripped.
//          enabled — today's behavior.
export const permissionTierSchema = z.enum([
  "disabled",
  "restricted",
  "enabled",
]);
export type PermissionTier = z.infer<typeof permissionTierSchema>;

const lanePermissionFieldsSchema = z.object({
  push: permissionTierSchema.optional(),
  shell: permissionTierSchema.optional(),
});

export interface LanePermissions {
  push: PermissionTier;
  shell: PermissionTier;
}

export const DEFAULT_LANE_PERMISSIONS: LanePermissions = {
  push: "enabled",
  shell: "enabled",
};

/** Applied when a repo's policy can't be read or doesn't parse. */
export const LOCKED_LANE_PERMISSIONS: LanePermissions = {
  push: "disabled",
  shell: "disabled",
};

export const PILE_REPO_TRIGGER_EVENTS = [
  "issue.created",
  "pr.opened",
  "pr.synchronize",
  "ci.failed",
  "mention",
  "label.added",
] as const;

export type PileRepoTriggerEvent = (typeof PILE_REPO_TRIGGER_EVENTS)[number];

// Event→lane trigger (PILE-275): when `on` fires for the repo, dispatch
// `agent` with `prompt` as the lane instructions.
export const pileRepoTriggerSchema = z.object({
  on: z.enum(PILE_REPO_TRIGGER_EVENTS),
  agent: z.string().nonempty(),
  model: z.string().optional(),
  prompt: z.string().nonempty(),
  // label.added only — fire for this label name; any label when omitted.
  label: z.string().optional(),
  // mention only — the handle a comment must contain (default "@pile").
  handle: z.string().optional(),
});

export type PileRepoTrigger = z.infer<typeof pileRepoTriggerSchema>;

export const pileRepoConfigSchema = z.object({
  // Lane agent allowlist — dispatch is rejected for anything not named here.
  agents: z.array(z.string()).optional(),
  // Default model applied when the dispatch request doesn't pick one.
  model: z.string().optional(),
  // PILE-293 — model per effort tier; beats `model` when the dispatch's
  // effort (explicit or priority-derived) has an entry.
  effortModels: effortModelsSchema.optional(),
  // Setup hook path, relative to the repo root. The runner executes it after
  // clone; defaults to .pile/setup.sh (which runs regardless of this file).
  setup: z.string().optional(),
  // Env-var names a repo allows to be injected into its lanes. Caller-supplied
  // extraEnv keys outside this list are dropped at dispatch time.
  env: z.array(z.string()).optional(),
  // Deterministic merge-conflict resolution (PILE-251). `generated` lists the
  // paths the repo regenerates from source — its contract artifacts — and
  // `regen` is the shell command that rebuilds them. When every file in a
  // lane PR's conflict set is declared here, the sweep runs a scripted fixer
  // (merge base branch → regen → commit → push) instead of nudging the lane.
  // Both fields are required for the fixer to engage.
  conflict: z
    .object({
      generated: z.array(z.string()).nonempty(),
      regen: z.string().nonempty(),
    })
    .optional(),
  // Lane permission policy (PILE-276). Top-level tiers apply to every agent;
  // `providers.<agentId>` overrides them per provider. Unset fields default
  // to "enabled".
  permissions: lanePermissionFieldsSchema
    .extend({
      providers: z.record(z.string(), lanePermissionFieldsSchema).optional(),
    })
    .optional(),
  // Event→lane triggers (PILE-275), processed by fireEventAutomations.
  triggers: z.array(pileRepoTriggerSchema).optional(),
  // Lane lifecycle hooks (PILE-279). Bash commands the lane runner reads
  // from the checkout and runs from the repo root: `setup` after clone,
  // `postCheckout` after every checkout (clone or kept-sandbox resume),
  // `prePush` before each push (nonzero blocks it), and `stop` after each
  // agent turn — nonzero resumes the agent with the hook output, up to
  // `stopMaxAttempts` times, so the lane fixes its own failures pre-PR.
  // A malformed block is dropped rather than invalidating the whole file —
  // the allowlists above must keep applying.
  hooks: z
    .object({
      setup: z.string().nonempty().optional(),
      postCheckout: z.string().nonempty().optional(),
      prePush: z.string().nonempty().optional(),
      stop: z.string().nonempty().optional(),
      stopMaxAttempts: z.number().int().min(0).max(5).optional(),
    })
    .optional()
    .catch(undefined),
});

export type PileRepoConfig = z.infer<typeof pileRepoConfigSchema>;

export function parsePileRepoConfig(raw: unknown): PileRepoConfig | null {
  const config = pileRepoConfigSchema.safeParse(raw);
  return config.success ? config.data : null;
}

export function resolveLanePermissions(
  config: PileRepoConfig | null,
  agentId: string
): LanePermissions {
  const policy = config?.permissions;
  const override = policy?.providers?.[agentId];
  return {
    push: override?.push ?? policy?.push ?? DEFAULT_LANE_PERMISSIONS.push,
    shell: override?.shell ?? policy?.shell ?? DEFAULT_LANE_PERMISSIONS.shell,
  };
}

type RepoConfigRead =
  | { kind: "found"; config: PileRepoConfig }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unreadable"; detail: string };

async function readPileRepoConfig(
  env: AppEnv,
  repo: string,
  ref?: string | null
): Promise<RepoConfigRead> {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) return { kind: "unreadable", detail: `invalid repo ${repo}` };
  const [, owner, name] = match;
  const token = await getInstallationTokenForRepo(env, owner, name);
  if (!token) {
    return { kind: "unreadable", detail: `no installation token for ${repo}` };
  }

  const url = new URL(
    `${GITHUB_API}/repos/${owner}/${name}/contents/.pile/config.json`
  );
  if (ref) url.searchParams.set("ref", ref);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": GITHUB_USER_AGENT,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn(
      `pile-repo-config: contents fetch ${res.status} for ${repo}${ref ? `@${ref}` : ""}: ${detail.slice(0, 200)}`
    );
    return res.status === 404
      ? { kind: "missing" }
      : { kind: "unreadable", detail: `contents fetch ${res.status}` };
  }

  const parsed = z
    .object({ content: z.string(), encoding: z.string() })
    .safeParse(await res.json());
  if (!parsed.success || parsed.data.encoding !== "base64") {
    return { kind: "invalid" };
  }

  try {
    const text = atob(parsed.data.content.replace(/\s/g, ""));
    const raw: unknown = JSON.parse(text);
    const config = parsePileRepoConfig(raw);
    return config ? { kind: "found", config } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Reads `.pile/config.json` from a repo via the GitHub contents API.
 * Returns null when the file doesn't exist or the repo can't be read.
 */
export async function fetchPileRepoConfig(
  env: AppEnv,
  repo: string,
  ref?: string | null
): Promise<PileRepoConfig | null> {
  const read = await readPileRepoConfig(env, repo, ref);
  return read.kind === "found" ? read.config : null;
}

export interface LanePermissionsResolution {
  permissions: LanePermissions;
  /** Set when the policy fell back to LOCKED_LANE_PERMISSIONS. */
  lockedReason?: string;
}

/**
 * Lane permission policy for `agentId` on `repo`, read from the default
 * branch only — a lane branch must not be able to loosen its own policy. No
 * config file resolves to the defaults; an unreadable or malformed one
 * fails closed to LOCKED_LANE_PERMISSIONS so a repo that tightened its
 * policy never silently runs with the defaults.
 */
export async function fetchLanePermissions(
  env: AppEnv,
  repo: string,
  agentId: string
): Promise<LanePermissionsResolution> {
  const read = await readPileRepoConfig(env, repo);
  switch (read.kind) {
    case "found":
      return { permissions: resolveLanePermissions(read.config, agentId) };
    case "missing":
      return { permissions: DEFAULT_LANE_PERMISSIONS };
    case "invalid":
      return {
        permissions: LOCKED_LANE_PERMISSIONS,
        lockedReason: ".pile/config.json is malformed",
      };
    case "unreadable":
      return {
        permissions: LOCKED_LANE_PERMISSIONS,
        lockedReason: `.pile/config.json unreadable: ${read.detail}`,
      };
  }
}

/**
 * GitHub App installation-token permissions for a lane under `push`.
 * `undefined` means the installation's full grant (still repo-scoped).
 */
export function laneTokenPermissions(
  push: PermissionTier
): Record<string, "read" | "write"> | undefined {
  if (push === "disabled") return { contents: "read", metadata: "read" };
  if (push === "restricted") {
    return { contents: "write", pull_requests: "write", metadata: "read" };
  }
  return undefined;
}

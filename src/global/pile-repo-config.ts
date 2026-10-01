import { z } from "zod";

import type { AppEnv } from "../types/env.js";
import {
  getInstallationTokenForRepo,
  GITHUB_USER_AGENT,
} from "./github-auth.js";

const GITHUB_API = "https://api.github.com";

export const pileRepoConfigSchema = z.object({
  // Lane agent allowlist — dispatch is rejected for anything not named here.
  agents: z.array(z.string()).optional(),
  // Default model applied when the dispatch request doesn't pick one.
  model: z.string().optional(),
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
  // Automated PR review lane (PILE-273). Present = enabled: every PR
  // open/synchronize on a Pile-tracked branch gets a repo-less review session
  // (`agent`, default devin-cli; `model` overrides the provider default) that
  // publishes a verdict comment and a `pile-review` check run.
  review: z
    .object({
      agent: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
});

export type PileRepoConfig = z.infer<typeof pileRepoConfigSchema>;

export function parsePileRepoConfig(raw: unknown): PileRepoConfig | null {
  const config = pileRepoConfigSchema.safeParse(raw);
  return config.success ? config.data : null;
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
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) return null;
  const [, owner, name] = match;
  const token = await getInstallationTokenForRepo(env, owner, name);
  if (!token) return null;

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
    return null;
  }

  const parsed = z
    .object({ content: z.string(), encoding: z.string() })
    .safeParse(await res.json());
  if (!parsed.success || parsed.data.encoding !== "base64") return null;

  try {
    const text = atob(parsed.data.content.replace(/\s/g, ""));
    const raw: unknown = JSON.parse(text);
    return parsePileRepoConfig(raw);
  } catch {
    return null;
  }
}

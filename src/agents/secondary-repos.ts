import { z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";

// PILE-294 — sibling repos cloned next to the lane's primary checkout under
// ~/xrepo/<owner>/<name>. `read` clones are reference-only; `write` clones get
// the lane branch, and the runner pushes it and opens a PR in that repo.
export const MAX_SECONDARY_REPOS = 5;

export const secondaryRepoSchema = z
  .object({
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected owner/name"),
    access: z.enum(["read", "write"]).default("read"),
  })
  .strict();

export const secondaryReposSchema = z
  .array(secondaryRepoSchema)
  .max(MAX_SECONDARY_REPOS);

export type SecondaryRepo = z.output<typeof secondaryRepoSchema>;

/** Rejects secondary repos that duplicate each other or the primary repo,
 *  or that are requested on a repo-less lane. */
export function validateSecondaryRepos(
  primaryRepo: string | null | undefined,
  repos: SecondaryRepo[] | undefined
): SecondaryRepo[] {
  if (!repos || repos.length === 0) return [];
  if (!primaryRepo) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "secondaryRepos requires the lane to have a primary repository",
    });
  }
  const seen = new Set([primaryRepo.toLowerCase()]);
  for (const { repo } of repos) {
    const key = repo.toLowerCase();
    if (seen.has(key)) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `secondaryRepos: "${repo}" duplicates the primary repository or another entry`,
      });
    }
    seen.add(key);
  }
  return repos;
}

/** agent_sessions.secondary_repos is JSON text; malformed values read as []. */
export function parseStoredSecondaryRepos(
  value: string | null | undefined
): SecondaryRepo[] {
  if (!value) return [];
  try {
    const parsed = secondaryReposSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

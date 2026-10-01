import { z } from "zod";

// PILE-286 — rolling PR-review snapshot persisted on the lane
// (agent_sessions.review_summary). One entry per GitHub review, ordered by
// review id (monotonic on GitHub), capped so the blob stays small.

const MAX_VERDICTS = 20;
const MAX_EXCERPT = 280;

const reviewVerdictSchema = z.object({
  reviewId: z.number().int(),
  reviewer: z.string(),
  state: z.string(),
  sha: z.string().nullable(),
  excerpt: z.string(),
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

const reviewSummarySchema = z.object({
  verdicts: z.array(reviewVerdictSchema),
});

export function parseReviewSummary(raw: string | null): ReviewVerdict[] {
  if (!raw) return [];
  try {
    const parsed = reviewSummarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.verdicts : [];
  } catch {
    return [];
  }
}

export function reviewExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EXCERPT
    ? `${flat.slice(0, MAX_EXCERPT - 1)}…`
    : flat;
}

/** Merge a verdict into the snapshot (replacing an existing entry for the
 *  same review id) and return the new blob + the sha of the newest verdict. */
export function rollReviewSummary(
  raw: string | null,
  verdict: ReviewVerdict
): { reviewSummary: string; lastReviewedSha: string | null } {
  const verdicts = parseReviewSummary(raw)
    .filter((v) => v.reviewId !== verdict.reviewId)
    .concat({ ...verdict, excerpt: reviewExcerpt(verdict.excerpt) })
    .toSorted((a, b) => a.reviewId - b.reviewId)
    .slice(-MAX_VERDICTS);
  const lastReviewedSha = verdicts.findLast((v) => v.sha !== null)?.sha ?? null;
  return {
    reviewSummary: JSON.stringify({ verdicts }),
    lastReviewedSha,
  };
}

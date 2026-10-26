import { z } from "zod";

// PILE-286 — rolling PR-review snapshot persisted on the lane
// (agent_sessions.review_summary). One entry per GitHub review, ordered by
// review id (monotonic on GitHub), capped so the blob stays small.

const MAX_VERDICTS = 20;
const MAX_EXCERPT = 280;

// PILE-642 — multi-axis Trail HUD scores persisted with each verdict so the
// review arc shows convergence, not just a flat pass/fail line. All fields
// optional — previously stored blobs remain valid.
export const trailScoresSchema = z.object({
  security: z.number().int().min(0).max(100),
  slop: z.number().int().min(0).max(100),
  invariants: z.number().int().min(0).max(100),
  humanGate: z.boolean(),
});
export type TrailScores = z.infer<typeof trailScoresSchema>;

const reviewVerdictSchema = z.object({
  reviewId: z.number().int(),
  reviewer: z.string(),
  state: z.string(),
  sha: z.string().nullable(),
  excerpt: z.string(),
  findingsCount: z.number().int().nonnegative().optional(),
  fingerprints: z.array(z.string()).optional(),
  scores: trailScoresSchema.optional(),
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

// PILE-642 — convergence over the rolling verdict window: whether each new
// review round is shrinking the finding set (converging), stuck on the same
// fingerprints (stalled), or bouncing (oscillating — the lane keeps
// re-breaking what it just fixed, or fix attempts spawn fresh findings).

export interface ReviewConvergenceSummary {
  rounds: number;
  findingsTrajectory: number[];
  resolvedFingerprints: string[];
  persistingFingerprints: string[];
  oscillating: boolean;
  status: "clean" | "converging" | "stalled" | "oscillating";
  trajectory: string;
}

export function evaluateReviewConvergence(
  verdicts: ReadonlyArray<ReviewVerdict>
): ReviewConvergenceSummary {
  const recent = verdicts.slice(-5);
  const findingsTrajectory = recent.map(
    (v) =>
      v.findingsCount ??
      v.fingerprints?.length ??
      (v.state.toUpperCase() === "APPROVED" || v.state === "approve" ? 0 : 1)
  );
  const latest = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const latestSet = new Set(latest?.fingerprints ?? []);
  const previousSet = new Set(previous?.fingerprints ?? []);
  // Still raised on the newest round AND raised on the round before — the
  // lane is not actually fixing them.
  const persistingFingerprints = [...latestSet].filter((fp) =>
    previousSet.has(fp)
  );
  // Raised on an earlier round but absent from the newest — genuinely fixed.
  const resolvedFingerprints = [
    ...new Set(recent.slice(0, -1).flatMap((v) => v.fingerprints ?? [])),
  ].filter((fp) => !latestSet.has(fp));

  const approved = latest
    ? latest.state.toUpperCase() === "APPROVED" || latest.state === "approve"
    : false;
  let status: ReviewConvergenceSummary["status"];
  let oscillating: boolean;
  if (latest && (findingsTrajectory.at(-1) ?? 1) === 0 && approved) {
    status = "clean";
    oscillating = false;
  } else if (recent.length >= 2) {
    const prevCount = findingsTrajectory[findingsTrajectory.length - 2]!;
    const currCount = findingsTrajectory[findingsTrajectory.length - 1]!;
    if (currCount < prevCount && persistingFingerprints.length === 0) {
      status = "converging";
      oscillating = false;
    } else if (
      currCount > prevCount ||
      (recent.length >= 3 &&
        currCount >= prevCount &&
        prevCount >= findingsTrajectory[findingsTrajectory.length - 3]!)
    ) {
      status = "oscillating";
      oscillating = true;
    } else if (currCount >= prevCount || persistingFingerprints.length > 0) {
      status = "stalled";
      oscillating = persistingFingerprints.length > 0 && currCount >= prevCount;
    } else {
      status = "converging";
      oscillating = false;
    }
  } else {
    status = findingsTrajectory[0] === 0 ? "clean" : "converging";
    oscillating = false;
  }

  return {
    rounds: verdicts.length,
    findingsTrajectory,
    resolvedFingerprints,
    persistingFingerprints,
    oscillating,
    status,
    trajectory: `${findingsTrajectory.join(" → ")} findings (${status})`,
  };
}

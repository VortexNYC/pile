import { z } from "zod";

import type { IssuePriority } from "../types/workspace.js";

// PILE-293 — per-dispatch run budgets. `effort` is a provider-agnostic tier
// that maps to a model per provider/repo config; `maxDuration` bounds the
// lane's wall-clock run and is enforced by the sweep.
export const DISPATCH_EFFORTS = ["low", "medium", "high", "max"] as const;
export type DispatchEffort = (typeof DISPATCH_EFFORTS)[number];
export const dispatchEffortSchema = z.enum(DISPATCH_EFFORTS);

export const MAX_DURATION_CEILING_MINUTES = 24 * 60;
export const maxDurationSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_DURATION_CEILING_MINUTES)
  .describe(
    "Wall-clock run budget in minutes; past it the lane is canceled and escalated on the issue"
  );

export const effortModelsSchema = z
  .object({
    low: z.string().min(1).optional(),
    medium: z.string().min(1).optional(),
    high: z.string().min(1).optional(),
    max: z.string().min(1).optional(),
  })
  .strict();
export type EffortModels = z.infer<typeof effortModelsSchema>;

const PRIORITY_EFFORT: Record<IssuePriority, DispatchEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  urgent: "max",
};

/** Explicit effort wins; otherwise the issue's priority picks the tier so
 *  low-priority/triage lanes run on the cheap model. */
export function resolveDispatchEffort(
  explicit: DispatchEffort | null | undefined,
  issue: { priority?: IssuePriority | null }
): DispatchEffort {
  if (explicit) return explicit;
  return issue.priority ? PRIORITY_EFFORT[issue.priority] : "medium";
}

/** `effortModels` from a provider config JSON blob (same blob that carries
 *  timeout/inactivityTimeout). Invalid or missing → null. */
export function parseEffortModels(
  configJson: string | null | undefined
): EffortModels | null {
  if (!configJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const result = effortModelsSchema.safeParse(
    (parsed as Record<string, unknown>).effortModels
  );
  return result.success ? result.data : null;
}

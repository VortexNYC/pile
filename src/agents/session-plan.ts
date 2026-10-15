import { z } from "zod";

/** PILE-426 — session plan checklist (Linear's AgentSession.plan): an
 *  ordered list of work items the agent publishes and maintains on its
 *  session. Every write replaces the array wholesale — there is no
 *  per-item update path. Statuses match Linear's enum exactly. */
export const sessionPlanItemSchema = z.object({
  content: z.string().min(1).max(500),
  status: z.enum(["pending", "inProgress", "completed", "canceled"]),
});

export const sessionPlanSchema = z.array(sessionPlanItemSchema).max(50);

export type SessionPlanItem = z.infer<typeof sessionPlanItemSchema>;
export type SessionPlan = z.infer<typeof sessionPlanSchema>;

/** The stored `agent_sessions.plan` column is JSON text; a hand-edited or
 *  legacy row degrades to null rather than poisoning the response. */
export function parseSessionPlan(value: string | null): SessionPlan | null {
  if (value === null) return null;
  try {
    const parsed = sessionPlanSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** done/total rollup for badges — `inProgress` counts as unfinished,
 *  `canceled` as done-with (it is a settled item, not remaining work). */
export function sessionPlanProgress(plan: SessionPlan): {
  done: number;
  total: number;
} {
  return {
    done: plan.filter(
      (item) => item.status === "completed" || item.status === "canceled"
    ).length,
    total: plan.length,
  };
}

/** Markdown checklist for the lane progress comment: `[x]` completed,
 *  `[ ]` pending, in-progress and canceled annotated in place. */
export function sessionPlanMarkdown(plan: SessionPlan): string[] {
  return plan.map((item) => {
    const line = item.content.split("\n")[0];
    if (item.status === "completed") return `- [x] ${line}`;
    if (item.status === "inProgress") return `- [ ] ${line} _(in progress)_`;
    if (item.status === "canceled") return `- [ ] ~~${line}~~ _(canceled)_`;
    return `- [ ] ${line}`;
  });
}

import { z } from "zod";
import type { IssueCursor, ListIssuesArgs } from "../workspace/types.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export const listIssuesQuerySchema = z.object({
  limit: z.preprocess((val) => {
    if (val === undefined) return DEFAULT_LIMIT;
    const n = Number(val);
    return Number.isNaN(n) || n < 1 || n > MAX_LIMIT ? DEFAULT_LIMIT : n;
  }, z.number().int().min(1).max(MAX_LIMIT)),
  cursor: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "done", "canceled"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
});

export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;

export function encodeCursor(cursor: IssueCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

export function decodeCursor(cursor: string): IssueCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(cursor));
  } catch {
    throw new Error("Invalid cursor");
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "createdAt" in parsed &&
    "id" in parsed
  ) {
    const { createdAt, id } = parsed as { createdAt: unknown; id: unknown };
    if (typeof createdAt === "string" && typeof id === "string") {
      return { createdAt, id };
    }
  }

  throw new Error("Invalid cursor");
}

export function toListArgs(query: ListIssuesQuery): ListIssuesArgs {
  const args: ListIssuesArgs = { limit: query.limit };
  if (query.cursor) {
    args.cursor = decodeCursor(query.cursor);
  }
  if (query.status) {
    args.status = query.status;
  }
  if (query.priority) {
    args.priority = query.priority;
  }
  return args;
}

import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssueCursor,
  type ListIssuesArgs,
} from "../types/workspace.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const booleanQueryParam = z
  .enum(["true", "false"])
  .optional()
  .transform((val) => {
    if (val === "true") return true;
    if (val === "false") return false;
    return undefined;
  });

export const listIssuesQuerySchema = z.object({
  limit: z.preprocess((val) => {
    if (val === undefined) return DEFAULT_LIMIT;
    const n = Number(val);
    return Number.isNaN(n) || n < 1 || n > MAX_LIMIT ? DEFAULT_LIMIT : n;
  }, z.number().int().min(1).max(MAX_LIMIT)),
  cursor: z.string().optional(),
  teamId: z.string().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  parentId: z.string().optional(),
  hasParent: booleanQueryParam,
  isParent: booleanQueryParam,
  isDraft: booleanQueryParam,
  includeSnoozed: booleanQueryParam,
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  cycleId: z.string().optional(),
  labelId: z.string().optional(),
  search: z.string().optional(),
  identifier: z.string().optional(),
  view: z.string().optional(),
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
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid cursor",
    });
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

  throw new VortexError({
    code: "BAD_REQUEST",
    status: 400,
    message: "Invalid cursor",
  });
}

export function toListArgs(query: ListIssuesQuery): ListIssuesArgs {
  const args: ListIssuesArgs = { limit: query.limit };
  if (query.cursor) {
    args.cursor = decodeCursor(query.cursor);
  }
  if (query.teamId) {
    args.teamId = query.teamId;
  }
  if (query.status) {
    args.status = query.status;
  }
  if (query.priority) {
    args.priority = query.priority;
  }
  if (query.parentId) {
    args.parentId = query.parentId;
  }
  if (query.hasParent !== undefined) {
    args.hasParent = query.hasParent;
  }
  if (query.isParent !== undefined) {
    args.isParent = query.isParent;
  }
  if (query.isDraft !== undefined) {
    args.isDraft = query.isDraft;
  }
  if (query.includeSnoozed !== undefined) {
    args.hideSnoozed = !query.includeSnoozed;
  }
  if (query.assigneeId) {
    args.assigneeId = query.assigneeId;
  }
  if (query.projectId) {
    args.projectId = query.projectId;
  }
  if (query.cycleId) {
    args.cycleId = query.cycleId;
  }
  if (query.labelId) {
    args.labelId = query.labelId;
  }
  if (query.search) {
    args.search = query.search;
  }
  return args;
}

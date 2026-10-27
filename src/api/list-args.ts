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

/** Bounded `limit` query param shared by the list endpoints — absent or
 *  invalid input falls back to the default, valid input is hard-capped. */
export function limitQueryParam(defaultLimit: number, maxLimit: number) {
  return z.preprocess((val) => {
    if (val === undefined) return defaultLimit;
    const n = Number(val);
    if (Number.isNaN(n) || n < 1) return defaultLimit;
    return Math.min(n, maxLimit);
  }, z.number().int().min(1).max(maxLimit));
}

export const listIssuesQuerySchema = z.object({
  limit: limitQueryParam(DEFAULT_LIMIT, MAX_LIMIT),
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
  delegateId: z.string().optional(),
  projectId: z.string().optional(),
  cycleId: z.string().optional(),
  labelId: z.string().optional(),
  search: z.string().optional(),
  identifier: z.string().optional(),
  externalRef: z.string().optional(),
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

/** Case-insensitive substring match for the bounded `q` params — true when
 *  any haystack contains the trimmed needle; an empty/absent q matches all. */
export function matchesSearchQuery(
  haystacks: readonly (string | null | undefined)[],
  q: string | undefined
): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((h) => h?.toLowerCase().includes(needle));
}

/** Keyset-page an in-memory list the way `listIssues` pages in SQL:
 *  (createdAt, id) descending, then everything strictly after the cursor.
 *  Emits `nextCursor` whenever the page fills — one more fetch confirms the
 *  end, the same contract as /issues. */
export function pageByCreatedCursor<
  T extends { createdAt: string; id: string },
>(
  rows: readonly T[],
  args: { limit: number; cursor?: IssueCursor }
): { page: T[]; nextCursor: string | undefined } {
  const sorted = [...rows].toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  );
  const cursor = args.cursor;
  const start = cursor
    ? sorted.findIndex(
        (row) =>
          row.createdAt < cursor.createdAt ||
          (row.createdAt === cursor.createdAt && row.id < cursor.id)
      )
    : 0;
  const page = sorted.slice(
    start === -1 ? sorted.length : start,
    (start === -1 ? sorted.length : start) + args.limit
  );
  const last = page.at(-1);
  const nextCursor =
    page.length === args.limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : undefined;
  return { page, nextCursor };
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
  if (query.delegateId) {
    args.delegateId = query.delegateId;
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
  if (query.externalRef) {
    args.externalRef = query.externalRef;
  }
  return args;
}

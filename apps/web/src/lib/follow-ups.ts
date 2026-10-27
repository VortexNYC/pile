// PILE-651 — Pure bucketing for the Sales → Follow-ups surface: a
// customer's `nextStepDueAt` sorts it into overdue / today / upcoming
// (the next 7 days), each group ordered soonest-first.

export const FOLLOW_UP_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/** ISO cutoff for `?dueBefore=` — anything due within the window. */
export function followUpDueBefore(now: number = Date.now()): string {
  return new Date(now + FOLLOW_UP_WINDOW_DAYS * DAY_MS).toISOString();
}

export type FollowUpBucket = "overdue" | "today" | "upcoming";

/** Local-day bucketing: anything due before today is overdue, due before
 *  tomorrow is today, the rest of the window is upcoming. */
export function followUpBucket(
  dueAtIso: string,
  now: number = Date.now()
): FollowUpBucket {
  const due = Date.parse(dueAtIso);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  if (due < todayStart.getTime()) return "overdue";
  if (due < todayStart.getTime() + DAY_MS) return "today";
  return "upcoming";
}

/** Row chip on CustomersList — true when the next step is already late. */
export function isFollowUpOverdue(
  dueAtIso: string | null | undefined,
  now: number = Date.now()
): boolean {
  return dueAtIso != null && followUpBucket(dueAtIso, now) === "overdue";
}

export interface FollowUpBuckets<T> {
  overdue: T[];
  today: T[];
  upcoming: T[];
}

/** Split due-soon rows into the three sections, each sorted by due ASC. */
export function bucketFollowUps<T extends { nextStepDueAt: string | null }>(
  rows: readonly T[],
  now: number = Date.now()
): FollowUpBuckets<T> {
  const buckets: FollowUpBuckets<T> = { overdue: [], today: [], upcoming: [] };
  for (const row of rows) {
    if (row.nextStepDueAt === null) continue;
    buckets[followUpBucket(row.nextStepDueAt, now)].push(row);
  }
  const byDue = (a: T, b: T) =>
    Date.parse(a.nextStepDueAt!) - Date.parse(b.nextStepDueAt!);
  buckets.overdue.sort(byDue);
  buckets.today.sort(byDue);
  buckets.upcoming.sort(byDue);
  return buckets;
}

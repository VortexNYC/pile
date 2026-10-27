import { describe, expect, it } from "vitest";

import {
  bucketFollowUps,
  followUpBucket,
  followUpDueBefore,
  isFollowUpOverdue,
} from "./follow-ups";

// A Monday at 15:00 local — buckets key off local-day boundaries.
const NOW = new Date(2026, 9, 26, 15, 0, 0).getTime();

function at(dayOffset: number, hour = 9): string {
  const d = new Date(NOW + dayOffset * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe("followUpBucket", () => {
  it("splits overdue / today / upcoming on local-day boundaries", () => {
    expect(followUpBucket(at(-1), NOW)).toBe("overdue");
    expect(followUpBucket(at(0, 8), NOW)).toBe("today");
    expect(followUpBucket(at(0, 23), NOW)).toBe("today");
    expect(followUpBucket(at(1), NOW)).toBe("upcoming");
    expect(followUpBucket(at(6), NOW)).toBe("upcoming");
  });
});

describe("isFollowUpOverdue", () => {
  it("flags only past-due timestamps and tolerates null", () => {
    expect(isFollowUpOverdue(at(-3), NOW)).toBe(true);
    expect(isFollowUpOverdue(at(0), NOW)).toBe(false);
    expect(isFollowUpOverdue(null, NOW)).toBe(false);
    expect(isFollowUpOverdue(undefined, NOW)).toBe(false);
  });
});

describe("bucketFollowUps", () => {
  it("groups rows and sorts each bucket by due ascending", () => {
    const rows = [
      { id: "later", nextStepDueAt: at(5) },
      { id: "today-b", nextStepDueAt: at(0, 18) },
      { id: "old", nextStepDueAt: at(-4) },
      { id: "today-a", nextStepDueAt: at(0, 8) },
      { id: "nodue", nextStepDueAt: null },
      { id: "yesterday", nextStepDueAt: at(-1) },
    ];
    const buckets = bucketFollowUps(rows, NOW);
    expect(buckets.overdue.map((r) => r.id)).toEqual(["old", "yesterday"]);
    expect(buckets.today.map((r) => r.id)).toEqual(["today-a", "today-b"]);
    expect(buckets.upcoming.map((r) => r.id)).toEqual(["later"]);
  });
});

describe("followUpDueBefore", () => {
  it("returns an ISO timestamp seven days out", () => {
    expect(Date.parse(followUpDueBefore(NOW))).toBe(NOW + 7 * 86_400_000);
  });
});

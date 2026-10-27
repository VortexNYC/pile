import { describe, expect, it } from "vitest";

import { bucketNotifications } from "./inbox-list";

const item = (createdAt: string) => ({ id: createdAt, createdAt });

describe("bucketNotifications", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");

  it("splits the feed at one week", () => {
    const { thisWeek, older } = bucketNotifications(
      [
        item("2026-10-26T11:00:00Z"),
        item("2026-10-19T12:00:00Z"), // exactly 7 days — boundary is "Older"
        item("2026-10-01T00:00:00Z"),
      ],
      now
    );
    expect(thisWeek.map((i) => i.id)).toEqual(["2026-10-26T11:00:00Z"]);
    expect(older.map((i) => i.id)).toEqual([
      "2026-10-19T12:00:00Z",
      "2026-10-01T00:00:00Z",
    ]);
  });

  it("keeps input order inside each bucket and handles an empty feed", () => {
    const empty = bucketNotifications([], now);
    expect(empty).toEqual({ thisWeek: [], older: [] });
  });
});

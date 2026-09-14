import { describe, expect, it } from "vitest";

import {
  getSlackIngestionMode,
  slackIngestionModeSchema,
} from "./ingestion.js";

describe("slackIngestionModeSchema", () => {
  it("allows the documented modes", () => {
    for (const mode of ["manual", "one_to_one", "time_based", "ai"]) {
      expect(slackIngestionModeSchema.parse(mode)).toBe(mode);
    }
  });

  it("rejects unknown modes", () => {
    expect(() => slackIngestionModeSchema.parse("auto")).toThrow();
  });
});

describe("getSlackIngestionMode", () => {
  it("returns one_to_one by default", () => {
    expect(getSlackIngestionMode("{}")).toBe("one_to_one");
  });

  it("returns one_to_one for missing or invalid config", () => {
    expect(getSlackIngestionMode("")).toBe("one_to_one");
    expect(getSlackIngestionMode("not-json")).toBe("one_to_one");
  });

  it("reads the configured mode", () => {
    expect(getSlackIngestionMode('{"ingestionMode":"manual"}')).toBe("manual");
    expect(getSlackIngestionMode('{"ingestionMode":"one_to_one"}')).toBe(
      "one_to_one"
    );
    expect(getSlackIngestionMode('{"ingestionMode":"time_based"}')).toBe(
      "time_based"
    );
    expect(getSlackIngestionMode('{"ingestionMode":"ai"}')).toBe("ai");
  });
});

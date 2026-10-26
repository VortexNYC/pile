import { describe, expect, it } from "vitest";

import {
  deviceInfoPairs,
  parseConsoleEntries,
  parseNetworkEntries,
  parseUserEventEntries,
} from "./capture-artifacts";

describe("parseConsoleEntries", () => {
  it("reads the Jam-style console_level/console_value fields", () => {
    const entries = parseConsoleEntries([
      {
        console_level: "error",
        console_value: "Network timeout",
        is_error: true,
        timestamp: "2026-10-27T10:00:00Z",
      },
      { console_level: "log", console_value: "render ok" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: "error",
      message: "Network timeout",
      isError: true,
    });
    expect(entries[1]?.isError).toBe(false);
  });

  it("skips non-record items and entries with no message", () => {
    const entries = parseConsoleEntries([
      "nope",
      { console_level: "log" },
      { console_value: "kept" },
    ]);
    expect(entries).toEqual([
      { level: "log", message: "kept", isError: false, timestamp: null },
    ]);
  });
});

describe("parseNetworkEntries", () => {
  it("reads network_url/method/status/duration and flags 4xx+", () => {
    const entries = parseNetworkEntries([
      {
        network_url: "https://api.example.com/checkout",
        network_method: "post",
        network_status: 500,
        duration_ms: 42,
      },
      {
        network_url: "https://a.b/ok",
        network_method: "GET",
        network_status: 200,
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      method: "POST",
      isError: true,
      durationMs: 42,
    });
    expect(entries[1]?.isError).toBe(false);
  });

  it("marks is_error entries with no status as errors", () => {
    const entries = parseNetworkEntries([
      { network_url: "https://a.b/fail", is_error: true },
    ]);
    expect(entries[0]?.isError).toBe(true);
    expect(entries[0]?.status).toBeNull();
  });
});

describe("parseUserEventEntries", () => {
  it("reads interactivity_action + target", () => {
    const entries = parseUserEventEntries([
      {
        event_type: "interactivity",
        interactivity_action: "click",
        target: "button.save",
        timestamp: "t",
      },
    ]);
    expect(entries[0]).toMatchObject({
      action: "click",
      target: "button.save",
      timestamp: "t",
    });
  });

  it("falls back across producer field names", () => {
    const entries = parseUserEventEntries([
      { action: "input", selector: "input#title" },
      { type: "navigation" },
    ]);
    expect(entries.map((e) => e.action)).toEqual(["input", "navigation"]);
    expect(entries[0]?.target).toBe("input#title");
  });
});

describe("deviceInfoPairs", () => {
  it("flattens primitives and joins nested objects", () => {
    const pairs = deviceInfoPairs({
      userAgent: "UA",
      online: true,
      viewport: { width: 1280, height: 800 },
      nothing: null,
    });
    expect(pairs).toContainEqual({ key: "userAgent", value: "UA" });
    expect(pairs).toContainEqual({ key: "online", value: "yes" });
    expect(pairs).toContainEqual({ key: "viewport", value: "1280 × 800" });
    expect(pairs).toHaveLength(3);
  });

  it("returns an empty list for missing info", () => {
    expect(deviceInfoPairs(null)).toEqual([]);
    expect(deviceInfoPairs(undefined)).toEqual([]);
  });
});

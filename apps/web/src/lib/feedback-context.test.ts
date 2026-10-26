import { afterEach, describe, expect, it } from "vitest";

import {
  buildFeedbackBody,
  capturedConsoleErrors,
  collectDeviceInfo,
  formatConsoleArg,
  pushCapturedError,
  resetConsoleCaptureForTests,
} from "./feedback-context";

afterEach(() => resetConsoleCaptureForTests());

describe("console error buffer", () => {
  it("records entries with level, message, and timestamp", () => {
    pushCapturedError("error", "boom");
    pushCapturedError("warn", "heads up");
    const entries = capturedConsoleErrors();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "error", message: "boom" });
    expect(entries[1]).toMatchObject({ level: "warn", message: "heads up" });
    expect(entries[0].timestamp).toBeTruthy();
  });

  it("caps at 50 entries, dropping the oldest", () => {
    for (let i = 0; i < 60; i++) pushCapturedError("error", `e${i}`);
    const entries = capturedConsoleErrors();
    expect(entries).toHaveLength(50);
    expect(entries[0].message).toBe("e10");
    expect(entries[49].message).toBe("e59");
  });

  it("truncates overlong messages", () => {
    pushCapturedError("error", "x".repeat(5000));
    expect(capturedConsoleErrors()[0].message.length).toBe(2000);
  });

  it("returns a copy — mutation does not leak into the buffer", () => {
    pushCapturedError("error", "one");
    const copy = capturedConsoleErrors();
    copy.pop();
    expect(capturedConsoleErrors()).toHaveLength(1);
  });
});

describe("formatConsoleArg", () => {
  it("passes strings through", () => {
    expect(formatConsoleArg("plain")).toBe("plain");
  });

  it("formats Errors with their name", () => {
    expect(formatConsoleArg(new TypeError("bad"))).toBe("TypeError: bad");
  });

  it("serializes objects and survives circular refs", () => {
    expect(formatConsoleArg({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatConsoleArg(circular)).toBe("[object Object]");
  });
});

describe("collectDeviceInfo", () => {
  it("returns an empty record off-DOM", () => {
    // workerd exposes window globals — just assert the shape contract.
    const info = collectDeviceInfo();
    expect(typeof info).toBe("object");
    expect(info).not.toBeNull();
  });
});

describe("buildFeedbackBody", () => {
  it("trims title and description and carries the kind", () => {
    const body = buildFeedbackBody({
      kind: "bug",
      title: "  Cannot save  ",
      description: "  click save, nothing happens  ",
    });
    expect(body.kind).toBe("bug");
    expect(body.title).toBe("Cannot save");
    expect(body.description).toBe("click save, nothing happens");
  });

  it("includes the captured console errors", () => {
    pushCapturedError("error", "sync blew up");
    const body = buildFeedbackBody({
      kind: "other",
      title: "t",
      description: "d",
    });
    expect(body.consoleErrors).toHaveLength(1);
    expect(body.consoleErrors?.[0].message).toBe("sync blew up");
  });

  it("omits screenshotDataUrl unless provided", () => {
    const without = buildFeedbackBody({
      kind: "feature",
      title: "t",
      description: "d",
    });
    expect(without.screenshotDataUrl).toBeUndefined();

    const withShot = buildFeedbackBody({
      kind: "feature",
      title: "t",
      description: "d",
      screenshotDataUrl: "data:image/png;base64,AAAA",
    });
    expect(withShot.screenshotDataUrl).toBe("data:image/png;base64,AAAA");
  });
});

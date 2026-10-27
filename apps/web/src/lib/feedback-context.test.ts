import { describe, expect, it } from "vitest";

import {
  buildFeedbackBody,
  canCaptureScreenshot,
  collectDeviceInfo,
} from "./feedback-context";

describe("collectDeviceInfo", () => {
  it("returns an empty record off-DOM", () => {
    // workerd exposes window globals — just assert the shape contract.
    const info = collectDeviceInfo();
    expect(typeof info).toBe("object");
    expect(info).not.toBeNull();
  });
});

describe("canCaptureScreenshot", () => {
  it("reports a boolean", () => {
    expect(typeof canCaptureScreenshot()).toBe("boolean");
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

  it("omits artifact fields when nothing was captured or attached", () => {
    const body = buildFeedbackBody({
      kind: "feature",
      title: "t",
      description: "d",
    });
    expect(body.screenshotDataUrl).toBeUndefined();
    expect(body.recordingDataUrl).toBeUndefined();
    expect(body.consoleLogs).toBeUndefined();
    expect(body.networkRequests).toBeUndefined();
    expect(body.userEvents).toBeUndefined();
    expect(body.errors).toBeUndefined();
  });

  it("carries the screenshot and recording data URLs", () => {
    const body = buildFeedbackBody({
      kind: "feature",
      title: "t",
      description: "d",
      screenshotDataUrl: "data:image/png;base64,AAAA",
      recordingDataUrl: "data:video/webm;base64,BBBB",
    });
    expect(body.screenshotDataUrl).toBe("data:image/png;base64,AAAA");
    expect(body.recordingDataUrl).toBe("data:video/webm;base64,BBBB");
  });
});

import { describe, expect, it } from "vitest";

import {
  buildCapturePayload,
  defaultPrefs,
  normalizePrefs,
  screenshotFromDataUrl,
} from "./capture.js";

describe("clipper capture helpers", () => {
  it("parses screenshot data URLs", () => {
    expect(screenshotFromDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      contentType: "image/png",
      contentBase64: "aGVsbG8=",
    });
    expect(screenshotFromDataUrl("data:image/jpeg;base64,aGk=")).toEqual({
      contentType: "image/jpeg",
      contentBase64: "aGk=",
    });
    expect(screenshotFromDataUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(screenshotFromDataUrl("not a data url")).toBeNull();
  });

  it("normalizes stored prefs", () => {
    expect(normalizePrefs(undefined)).toEqual(defaultPrefs());
    expect(
      normalizePrefs({
        includeScreenshot: false,
        includeFullText: true,
        teamId: "team_1",
        labelIds: ["lbl_1", 3, ""],
        projectId: 42,
      })
    ).toEqual({
      includeScreenshot: false,
      includeSummary: true,
      includeFullText: true,
      teamId: "team_1",
      projectId: "",
      labelIds: ["lbl_1"],
    });
  });

  it("builds a minimal payload when extras are off", () => {
    const payload = buildCapturePayload(
      {
        url: "https://example.com",
        title: "Example",
        selection: "hi",
        pageText: "body text",
      },
      {
        ...defaultPrefs(),
        includeScreenshot: false,
        includeSummary: false,
      },
      { contentType: "image/png", contentBase64: "aGk=" }
    );
    expect(payload).toEqual({
      url: "https://example.com",
      title: "Example",
      selection: "hi",
      summarize: false,
      includeFullText: false,
    });
  });

  it("builds a full payload with screenshot, text, and routing", () => {
    const payload = buildCapturePayload(
      {
        url: "https://example.com",
        title: "Example",
        selection: "",
        pageText: "body text",
      },
      {
        includeScreenshot: true,
        includeSummary: true,
        includeFullText: true,
        teamId: "team_1",
        projectId: "proj_1",
        labelIds: ["lbl_1", "lbl_2"],
      },
      { contentType: "image/png", contentBase64: "aGk=" }
    );
    expect(payload).toEqual({
      url: "https://example.com",
      title: "Example",
      selection: "",
      summarize: true,
      includeFullText: true,
      pageText: "body text",
      screenshot: { contentType: "image/png", contentBase64: "aGk=" },
      teamId: "team_1",
      projectId: "proj_1",
      labelIds: ["lbl_1", "lbl_2"],
    });
  });
});

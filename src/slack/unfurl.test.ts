import { describe, expect, it } from "vitest";

import {
  buildUnfurlBlocks,
  isLinkSharedPayload,
  parsePileUrl,
} from "./unfurl.js";

describe("slack unfurl", () => {
  it("detects a link_shared event callback", () => {
    const ok = {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "link_shared",
        channel: "C1",
        message_ts: "123.456",
        links: [{ url: "https://pile.nyc/org-1/issues/ISS-42" }],
      },
    };
    expect(isLinkSharedPayload(ok)).toBe(true);
  });

  it("rejects a url_verification payload", () => {
    const no = {
      type: "url_verification",
      challenge: "abc",
    };
    expect(isLinkSharedPayload(no)).toBe(false);
  });

  it("rejects a plain message event", () => {
    const no = {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        channel: "C1",
      },
    };
    expect(isLinkSharedPayload(no)).toBe(false);
  });

  it("parses a pile issue URL", () => {
    expect(parsePileUrl("https://pile.nyc/org-1/issues/ISS-42")).toEqual({
      organizationId: "org-1",
      identifier: "ISS-42",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parsePileUrl("https://pile.nyc/org-1/issues/ISS-42/")).toEqual({
      organizationId: "org-1",
      identifier: "ISS-42",
    });
  });

  it("returns null for non-pile URLs", () => {
    expect(parsePileUrl("https://example.com/org-1/issues/ISS-42")).toBeNull();
    expect(parsePileUrl("https://pile.nyc/org-1/comments/C-1")).toBeNull();
  });

  it("builds a customer-safe unfurl", () => {
    const unfurl = buildUnfurlBlocks("https://pile.nyc/org-1/issues/ISS-42", {
      id: "id-1",
      identifier: "ISS-42",
      title: "Slack thread sync",
      status: "in_progress",
      priority: "urgent",
    });

    expect(unfurl["https://pile.nyc/org-1/issues/ISS-42"]).toBeDefined();
    const blocks = unfurl["https://pile.nyc/org-1/issues/ISS-42"].blocks;
    expect(blocks.length).toBe(3);
    expect(JSON.stringify(blocks)).toContain("ISS-42: Slack thread sync");
    expect(JSON.stringify(blocks)).toContain("in_progress");
    expect(JSON.stringify(blocks)).toContain("urgent");
    expect(JSON.stringify(blocks)).toContain("View in Pile");
  });
});

import { describe, expect, it } from "vitest";

import {
  derivedStatusVariant,
  documentText,
  formatRelative,
  isIssueStatus,
  isTicketStatus,
  notificationLabel,
  sessionStatusVariant,
  slugify,
} from "./labels";

describe("labels", () => {
  it("narrows enums", () => {
    expect(isIssueStatus("in_progress")).toBe(true);
    expect(isIssueStatus("dispatched")).toBe(false);
    expect(isTicketStatus("snoozed")).toBe(true);
    expect(isTicketStatus(3)).toBe(false);
  });
  it("humanizes notification types", () => {
    expect(notificationLabel("issue_assigned")).toBe(
      "You were assigned an issue"
    );
    expect(notificationLabel("ticket.reopened")).toBe("Ticket reopened");
    expect(notificationLabel("")).toBe("Notification");
  });
  it("flattens block content", () => {
    expect(documentText("plain")).toBe("plain");
    expect(
      documentText([{ type: "p", children: [{ text: "a" }] }, { text: "b" }])
    ).toBe("a\nb");
  });
  it("slugifies workspace names", () => {
    expect(slugify("  Acme Field Sales! ")).toBe("acme-field-sales");
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(formatRelative("2026-01-01T00:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("bad", now)).toBe("");
  });
});

describe("sessionStatusVariant", () => {
  it("maps live and terminal statuses", () => {
    expect(sessionStatusVariant("running")).toBe("blue");
    expect(sessionStatusVariant("waiting")).toBe("purple");
    expect(sessionStatusVariant("completed")).toBe("green");
    expect(sessionStatusVariant("failed")).toBe("red");
    expect(sessionStatusVariant("created")).toBe("neutral");
    expect(sessionStatusVariant("canceled")).toBe("neutral");
  });
});

describe("derivedStatusVariant", () => {
  it("maps derived statuses and passes through absence", () => {
    expect(derivedStatusVariant("stalled")).toBe("orange");
    expect(derivedStatusVariant("needs_input")).toBe("purple");
    expect(derivedStatusVariant(null)).toBeNull();
    expect(derivedStatusVariant(undefined)).toBeNull();
  });
});

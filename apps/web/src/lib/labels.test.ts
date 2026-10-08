import { describe, expect, it } from "vitest";

import {
  documentText,
  formatRelative,
  isIssueStatus,
  isTicketStatus,
  notificationLabel,
  notificationTarget,
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
  it("hides CLI-only notification wording", () => {
    expect(notificationLabel("lane_needs_input")).toBe(
      "An issue needs your input"
    );
  });
  it("routes notifications to their real subject", () => {
    expect(
      notificationTarget({
        type: "document_commented",
        issueId: "doc_1",
        metadata: { documentId: "doc_1", commentId: "c" },
      })
    ).toEqual({ kind: "document", id: "doc_1" });
    expect(
      notificationTarget({
        type: "document_updated",
        issueId: "iss_1",
        metadata: { documentId: "doc_2" },
      })
    ).toEqual({ kind: "document", id: "doc_2" });
    expect(
      notificationTarget({
        type: "mention",
        issueId: "iss_3",
        metadata: { documentId: null, issueId: "iss_3" },
      })
    ).toEqual({ kind: "issue", id: "iss_3" });
    expect(
      notificationTarget({ type: "issue_assigned", issueId: "iss_4" })
    ).toEqual({ kind: "issue", id: "iss_4" });
    expect(
      notificationTarget({ type: "issue_deleted", issueId: "iss_5" })
    ).toBeNull();
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

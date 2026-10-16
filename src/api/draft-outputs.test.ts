import { describe, expect, it } from "vitest";

import type { DraftOutput } from "../types/workspace.js";
import {
  draftCommentPayloadSchema,
  draftOutputSchema,
  serializeDraft,
} from "./draft-outputs.js";

function draftRow(overrides: Partial<DraftOutput> = {}): DraftOutput {
  return {
    id: "draft-1",
    organizationId: "org-1",
    entityType: "issue",
    entityId: "issue-1",
    issueId: "issue-1",
    kind: "comment",
    payload: "{}",
    status: "pending",
    createdById: null,
    sessionId: null,
    reviewedById: null,
    reviewedAt: null,
    reviewNote: null,
    publishedCommentId: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("draft output wire shapes (PILE-428)", () => {
  it("accepts a minimal comment payload plus the optional syncToRepo flag", () => {
    const minimal = draftCommentPayloadSchema.parse({ body: "held comment" });
    expect(minimal.body).toBe("held comment");

    const full = draftCommentPayloadSchema.parse({
      body: "held comment",
      authorId: "agent-1",
      mentions: ["user-1"],
      internal: true,
      externalId: "42",
      externalSource: "github",
      externalAuthor: "pile-agent",
      syncToRepo: true,
    });
    expect(full.syncToRepo).toBe(true);
  });

  it("rejects a comment payload with an empty body", () => {
    expect(draftCommentPayloadSchema.safeParse({ body: "" }).success).toBe(
      false
    );
    expect(draftCommentPayloadSchema.safeParse({}).success).toBe(false);
  });

  it("serializes a draft with its payload parsed back to an object", () => {
    const draft = draftRow({
      payload: JSON.stringify({ body: "agent draft", syncToRepo: true }),
    });
    const serialized = serializeDraft(draft);
    expect(serialized.payload).toEqual({
      body: "agent draft",
      syncToRepo: true,
    });
    // The serialized shape satisfies the OpenAPI response schema.
    const parsed = draftOutputSchema.parse(serialized);
    expect(parsed.id).toBe("draft-1");
    expect(parsed.status).toBe("pending");
  });

  it("serializes a malformed stored payload as an empty object", () => {
    const draft = draftRow({ payload: "not-json{{{" });
    expect(serializeDraft(draft).payload).toEqual({});

    const array = draftRow({ payload: "[1,2,3]" });
    expect(serializeDraft(array).payload).toEqual({});
  });
});

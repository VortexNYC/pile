import { z } from "@hono/zod-openapi";

import type { DraftOutput } from "../types/workspace.js";
import {
  DRAFT_OUTPUT_KINDS,
  DRAFT_OUTPUT_STATUSES,
} from "../types/workspace.js";

// PILE-428 — shared wire shape for draft_outputs rows. `payload` is the
// parsed JSON the publish step replays (shape depends on `kind`).

export const draftCommentPayloadSchema = z.object({
  body: z.string().min(1),
  authorId: z.string().nullable().optional(),
  mentions: z.array(z.string()).optional(),
  internal: z.boolean().optional(),
  externalId: z.string().nullable().optional(),
  externalSource: z.string().nullable().optional(),
  externalAuthor: z.string().nullable().optional(),
  // Set by the API comment path — on publish the comment additionally
  // syncs to the issue's GitHub/GitLab mapping, matching what the
  // original POST would have done.
  syncToRepo: z.boolean().optional(),
});

export const draftOutputSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    issueId: z.string().nullable(),
    kind: z.enum(DRAFT_OUTPUT_KINDS),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(DRAFT_OUTPUT_STATUSES),
    createdById: z.string().nullable(),
    sessionId: z.string().nullable(),
    reviewedById: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewNote: z.string().nullable(),
    publishedCommentId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("DraftOutput");

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through — a malformed payload serializes empty rather than 500s
  }
  return {};
}

export function serializeDraft(draft: DraftOutput) {
  return { ...draft, payload: parsePayload(draft.payload) };
}

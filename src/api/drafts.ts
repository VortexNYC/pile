import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { DRAFT_OUTPUT_STATUSES } from "../types/workspace.js";
import type { DraftOutput } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import {
  draftCommentPayloadSchema,
  draftOutputSchema,
  serializeDraft,
} from "./draft-outputs.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { assertIssueAccess } from "./issue-access.js";
import {
  resolveIssuePatch,
  syncIssueWriteEffects,
  updateIssueSchema,
} from "./issues.js";
import { syncCommentToRepoMapping } from "./repo-comment-sync.js";
import { getWorkspaceStub } from "./stub.js";

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** The human gate: drafts exist so a person decides — agent identities
 *  may produce them but never resolve them. */
function assertHumanReviewer(identity: WorkspaceIdentity) {
  if (identity.type !== "user") {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "Only a human reviewer can resolve agent drafts",
    });
  }
}

/** Draft access follows the record it hangs on: a caller must pass
 *  issue-access on the draft's issue to see or resolve it. Drafts with no
 *  reachable issue fall back to the route's workspace permission. */
async function assertDraftAccess(
  db: ReturnType<typeof createD1>,
  stub: WorkspaceStub,
  draft: DraftOutput,
  identity: WorkspaceIdentity
) {
  if (!draft.issueId) return;
  const issue = await stub.getIssue(draft.issueId);
  if (issue) await assertIssueAccess(db, stub, issue, identity);
}

const listIssueDraftsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/drafts",
  tags: ["drafts"],
  middleware: [rls("issue:view")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    query: z.object({
      status: z.enum(DRAFT_OUTPUT_STATUSES).optional(),
    }),
  },
  responses: {
    200: {
      description: "Draft outputs held on this record",
      content: {
        "application/json": {
          schema: z.object({ drafts: z.array(draftOutputSchema) }),
        },
      },
    },
  },
});

const listDraftsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/drafts",
  tags: ["drafts"],
  middleware: [rls("issue:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      status: z.enum(DRAFT_OUTPUT_STATUSES).optional(),
      issueId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description:
        "The workspace draft-review queue — pending agent output awaiting a human publish/discard decision",
      content: {
        "application/json": {
          schema: z.object({ drafts: z.array(draftOutputSchema) }),
        },
      },
    },
  },
});

const editDraftRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/drafts/{id}",
  tags: ["drafts"],
  middleware: [rls("issue:edit")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            payload: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Draft payload updated",
      content: { "application/json": { schema: draftOutputSchema } },
    },
  },
});

const publishDraftRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/drafts/{id}/publish",
  tags: ["drafts"],
  middleware: [rls("issue:edit")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ note: z.string().optional() }).optional(),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Draft published — the held write applied and the audit log records both the producing agent and the reviewing human",
      content: { "application/json": { schema: draftOutputSchema } },
    },
  },
});

const discardDraftRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/drafts/{id}/discard",
  tags: ["drafts"],
  middleware: [rls("issue:edit")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ note: z.string().optional() }).optional(),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Draft discarded — the write never applied; the row is retained for inspection",
      content: { "application/json": { schema: draftOutputSchema } },
    },
  },
});

export function registerDraftRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssueDraftsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, stub, issue, identity);
    const drafts = await stub.listDraftOutputs({
      entityType: "issue",
      entityId: issue.id,
      status,
    });
    return c.json({ drafts: drafts.map(serializeDraft) }, 200);
  });

  app.openapi(listDraftsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { status, issueId } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    if (issueId) {
      const issue = await stub.getIssue(issueId);
      if (!issue) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Issue not found",
        });
      }
      await assertIssueAccess(db, stub, issue, identity);
    }
    const drafts = await stub.listDraftOutputs({ status, issueId });
    // Restricted issues hide their drafts from callers they don't grant —
    // resolve access once per distinct issue.
    const issueIds = [
      ...new Set(
        drafts
          .map((draft) => draft.issueId)
          .filter((id): id is string => id !== null)
      ),
    ];
    const accessible = new Set(
      (
        await Promise.all(
          issueIds.map(async (id) => {
            const issue = await stub.getIssue(id);
            if (!issue) return null;
            try {
              await assertIssueAccess(db, stub, issue, identity);
              return id;
            } catch {
              return null;
            }
          })
        )
      ).filter((id): id is string => id !== null)
    );
    const visible = drafts.filter(
      (draft) => !draft.issueId || accessible.has(draft.issueId)
    );
    return c.json({ drafts: visible.map(serializeDraft) }, 200);
  });

  app.openapi(editDraftRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { payload } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    assertHumanReviewer(identity);
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const draft = await stub.getDraftOutput(id);
    if (!draft) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Draft output not found",
      });
    }
    await assertDraftAccess(db, stub, draft, identity);
    // Re-validate the edited payload against the kind's contract — a
    // malformed edit fails here, not at publish hours later.
    let nextPayload: Record<string, unknown>;
    if (draft.kind === "comment") {
      nextPayload = draftCommentPayloadSchema.parse(payload);
    } else if (draft.kind === "field_change") {
      const fields = updateIssueSchema.parse(payload.fields);
      nextPayload = { fields };
    } else {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `Draft kind "${draft.kind}" has no editable payload contract`,
      });
    }
    const updated = await stub.updateDraftOutputPayload(
      id,
      nextPayload,
      identity.id
    );
    return c.json(serializeDraft(updated), 200);
  });

  app.openapi(publishDraftRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const note = c.req.valid("json")?.note;
    const identity = c.get("workspaceIdentity");
    assertHumanReviewer(identity);
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const draft = await stub.getDraftOutput(id);
    if (!draft) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Draft output not found",
      });
    }
    await assertDraftAccess(db, stub, draft, identity);

    if (draft.kind === "field_change") {
      // The held patch re-validates against the CURRENT record — the
      // world may have moved since the agent wrote the draft.
      if (draft.entityType !== "issue") {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: `Cannot publish field_change on entity type "${draft.entityType}"`,
        });
      }
      const target = await stub.getIssue(draft.entityId);
      if (!target) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Draft target issue not found",
        });
      }
      const raw: unknown = JSON.parse(draft.payload);
      const fields = updateIssueSchema.parse(
        (raw as { fields?: unknown }).fields
      );
      const resolved = await resolveIssuePatch(
        c.env,
        db,
        stub,
        organizationId,
        target,
        fields,
        identity
      );
      const published = await stub.publishDraftOutput(id, identity.id, note);
      const updatedIssue = await stub.getIssue(draft.entityId);
      if (updatedIssue) {
        await syncIssueWriteEffects(
          c.env,
          db,
          stub,
          organizationId,
          target,
          updatedIssue,
          resolved,
          identity,
          getExecutionCtx(c)
        );
      }
      return c.json(serializeDraft(published), 200);
    }

    const published = await stub.publishDraftOutput(id, identity.id, note);
    if (draft.kind === "comment" && published.publishedCommentId) {
      const comment = await stub.getComment(published.publishedCommentId);
      const issue = draft.issueId
        ? await stub.getIssue(draft.issueId)
        : undefined;
      if (comment && issue && draft.entityType === "issue") {
        await stub.indexComment({
          id: comment.id,
          issueId: issue.id,
          teamId: issue.teamId,
          body: comment.body,
          createdAt: comment.createdAt,
        });
        const payload = JSON.parse(draft.payload) as {
          syncToRepo?: boolean;
        };
        if (payload.syncToRepo === true) {
          await syncCommentToRepoMapping(c.env, db, stub, issue, {
            id: comment.id,
            body: comment.body,
          });
        }
      }
    }
    return c.json(serializeDraft(published), 200);
  });

  app.openapi(discardDraftRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const note = c.req.valid("json")?.note;
    const identity = c.get("workspaceIdentity");
    assertHumanReviewer(identity);
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const draft = await stub.getDraftOutput(id);
    if (!draft) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Draft output not found",
      });
    }
    await assertDraftAccess(db, stub, draft, identity);
    const updated = await stub.discardDraftOutput(id, identity.id, note);
    return c.json(serializeDraft(updated), 200);
  });
}

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { loadProviderConfig } from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import {
  followupThrottleWindowMs,
  laneFollowupThrottled,
} from "../agents/followup.js";
import { getAgentProvider } from "../agents/index.js";
import { dispatchAgent } from "../agents/index.js";
import { triggerPlanMode } from "../agents/plan-dispatch.js";
import { parsePlanCommand } from "../agents/plan.js";
import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { draftOutputSchema, serializeDraft } from "./draft-outputs.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { assertIssueAccess } from "./issue-access.js";
import { resolveMentions } from "./mentions.js";
import { syncCommentToRepoMapping } from "./repo-comment-sync.js";

async function getStub(env: WorkerEnv, organizationId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  return stub;
}

function commentOut(c: {
  id: string;
  organizationId: string;
  entityType: string | null;
  entityId: string | null;
  authorId: string | null;
  body: string;
  internal: boolean;
  externalId: string | null;
  externalSource: string | null;
  externalAuthor: string | null;
  resolvedAt: string | null;
  resolvedById: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ...c,
    issueId: c.entityType === "issue" ? c.entityId : null,
    documentId: c.entityType === "document" ? c.entityId : null,
  };
}

const commentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string().nullable(),
  documentId: z.string().nullable(),
  authorId: z.string().nullable(),
  body: z.string(),
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  externalAuthor: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** PILE-435 — an @mention that resolves to a registered agent type
 *  dispatches a lane (mentions today notify humans but never wake agents).
 *  Slugs normalize like stage keys: @sales-scout ≈ @sales_scout. */
const AGENT_MENTION_RE = /@([a-zA-Z0-9._-]{2,})/g;
async function resolveAgentMentions(
  stub: Awaited<ReturnType<typeof getStub>>,
  body: string
) {
  const handles = new Set(
    [...body.matchAll(AGENT_MENTION_RE)].map((m) => m[1])
  );
  const types = [];
  for (const handle of handles) {
    const agentType = await stub
      .getAgentTypeBySlug(handle)
      .catch(() => undefined);
    if (agentType) types.push(agentType);
  }
  return types;
}

const createCommentBodySchema = z.object({
  body: z.string().min(1),
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("issue:view")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Comments list",
      content: {
        "application/json": {
          schema: z.object({ comments: z.array(commentSchema) }),
        },
      },
    },
  },
});

const createCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("issue:create")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createCommentBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
    202: {
      description:
        "Agent output held for review — the issue is flagged sensitive, so the comment was stored as a pending draft instead of posting",
      content: {
        "application/json": {
          schema: z.object({ draft: draftOutputSchema }),
        },
      },
    },
  },
});

const getCommentRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("issue:view")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Comment",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
  },
});

const updateCommentRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("issue:edit")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: createCommentBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Comment updated",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
  },
});

const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("issue:delete")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Comment deleted" },
  },
});

const resolveIssueCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}/resolve",
  tags: ["comments"],
  middleware: [rls("issue:create")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Comment resolved",
      content: { "application/json": { schema: commentSchema } },
    },
    404: { description: "Comment not found" },
  },
});

const unresolveIssueCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}/unresolve",
  tags: ["comments"],
  middleware: [rls("issue:create")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Comment unresolved",
      content: { "application/json": { schema: commentSchema } },
    },
    404: { description: "Comment not found" },
  },
});

export function registerCommentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listCommentsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issueStub, issue, identity);
    const items = await issueStub.listComments(issue.id);
    return c.json({ comments: items.map(commentOut) });
  });

  app.openapi(createCommentRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    if (!body) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Comment body is required",
      });
    }
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issueStub, issue, identity);
    const mentions = await resolveMentions(db, organizationId, body);
    // PILE-428 — an agent writing on a sensitive record drafts for human
    // review: no comment posts, no GitHub/GitLab sync, no follow-up
    // prompt. Publishing replays this exact write (syncToRepo marks the
    // mirror sync the POST would have performed).
    if (identity.type === "agent" && issue.sensitive) {
      const draft = await issueStub.createDraftOutput({
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        kind: "comment",
        payload: {
          body,
          authorId: identity.id,
          mentions,
          syncToRepo: true,
        },
        createdById: identity.id,
      });
      return c.json({ draft: serializeDraft(draft) }, 202);
    }
    const created = await issueStub.createComment({
      issueId: issue.id,
      authorId: identity.id,
      body,
      mentions,
    });
    // PILE-435 — @agent-slug in a human comment wakes that agent on the
    // issue. Agent-authored comments skip this to keep lanes from
    // dispatching each other in a loop.
    if (identity.type !== "agent") {
      const agentTypes = await resolveAgentMentions(issueStub, body);
      for (const agentType of agentTypes) {
        const request = body.replace(AGENT_MENTION_RE, "").trim();
        // Awaited inline — the same contract the drainer uses; a mention
        // is a deliberate human action, not a background fan-out.
        await dispatchAgent(
          c.env,
          agentType.providerAgentId,
          organizationId,
          issue,
          identity,
          undefined,
          getExecutionCtx(c),
          {
            instructions: [
              agentType.jobSpec ?? "",
              "",
              `You were mentioned by ${identity.id} on ${issue.identifier ?? issue.id}:`,
              "",
              request || "(mention with no request text)",
            ].join("\n"),
          }
        ).catch((err: unknown) => {
          console.error("mention dispatch failed", {
            agentSlug: agentType.slug,
            issueId: issue.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    if (!created) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to create comment",
      });
    }
    let item = created;

    await issueStub.indexComment({
      id: item.id,
      issueId: issue.id,
      teamId: issue.teamId,
      body: item.body,
      createdAt: item.createdAt,
    });

    await syncCommentToRepoMapping(c.env, db, issueStub, issue, {
      id: item.id,
      body: item.body,
    });
    const synced = await issueStub.getComment(item.id);
    if (synced) {
      item = synced;
    }

    await issueStub.emitCommentCreated(item, issue, identity.id);

    // PILE-283 — `/plan [feedback]` dispatches (or revises) a plan lane;
    // `/implement_plan` dispatches a build lane from the latest plan. With a
    // live lane the comment falls through to the follow-up path below.
    const planCommand = parsePlanCommand(body);
    let planHandled = false;
    if (planCommand) {
      const live = await issueStub
        .getActiveAgentSessionForIssue(issue.id)
        .catch(() => null);
      if (!live) {
        planHandled = true;
        await triggerPlanMode(
          c.env,
          db,
          issueStub,
          organizationId,
          issue,
          identity,
          planCommand,
          getExecutionCtx(c)
        );
      }
    }

    // PILE-211 — a comment on an issue with a live lane becomes a follow-up
    // prompt when the sandbox is still warm; else it's just a comment the
    // lane never sees (orchestrators use /prompt or /retry explicitly).
    if (identity.type === "user" && !planHandled) {
      const active = await issueStub
        .getActiveAgentSessionForIssue(issue.id)
        .catch(() => null);
      if (
        active &&
        (active.session.status === "running" ||
          active.session.status === "waiting")
      ) {
        try {
          const providerConfig = await loadProviderConfig(
            c.env,
            issueStub,
            active.session.agentId
          );
          const provider = getAgentProvider(
            active.session.agentId,
            resolveAgentEnv(c.env, providerConfig ?? undefined)
          );
          if (provider.sendPrompt) {
            const windowMs = followupThrottleWindowMs(providerConfig?.config);
            if (
              await laneFollowupThrottled(
                issueStub,
                active.session.id,
                windowMs
              )
            ) {
              await issueStub
                .addAgentSessionEvent({
                  sessionId: active.session.id,
                  type: "prompt.followup_skipped",
                  message:
                    "Comment follow-up throttled (recent nudge within 5m)",
                  payload: { commentId: item.id },
                })
                .catch(() => {});
            } else {
              const gitIdentity = issue.repo
                ? ((await issueStub.getGitIdentityByRepo(issue.repo)) ?? null)
                : null;
              const delivered = await provider.sendPrompt(
                active.session.providerSessionId ?? active.session.id,
                `${identity.id} commented on ${issue.identifier ?? issue.id}:\n\n${body}`,
                issue,
                gitIdentity,
                {
                  organizationId,
                  backupRef: active.session.sandboxBackupRef ?? null,
                }
              );
              if (delivered) {
                await issueStub
                  .addAgentSessionEvent({
                    sessionId: active.session.id,
                    type: "prompt.followup",
                    message: "Issue comment delivered as follow-up prompt",
                    payload: { commentId: item.id },
                  })
                  .catch(() => {});
                await issueStub.applyAgentSessionResult(
                  active.session.id,
                  { status: "running", result: null },
                  identity.id
                );
              }
            }
          }
        } catch (err) {
          console.error("comment follow-up prompt failed", {
            issueId: issue.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return c.json(commentOut(item), 201);
  });

  app.openapi(getCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const item = await issueStub.getComment(id);
    const issue = item ? await issueStub.getIssue(issueId) : undefined;
    if (!item || !issue || item.entityId !== issue.id) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await assertIssueAccess(db, issueStub, issue, identity);
    return c.json(commentOut(item));
  });

  app.openapi(updateCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const existing = await issueStub.getComment(id);
    const issue = existing ? await issueStub.getIssue(issueId) : undefined;
    if (!existing || !issue || existing.entityId !== issue.id) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await assertIssueAccess(db, issueStub, issue, identity);
    const item = await issueStub.updateComment(id, { body });
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await issueStub.emitCommentUpdated(item, issue);
    return c.json(commentOut(item));
  });

  app.openapi(deleteCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const existing = await issueStub.getComment(id);
    const issue = existing ? await issueStub.getIssue(issueId) : undefined;
    if (!existing || !issue || existing.entityId !== issue.id) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await assertIssueAccess(db, issueStub, issue, identity);
    await issueStub.deleteComment(id);
    await issueStub.emitCommentDeleted(id, issue.id);
    return c.body(null, 204);
  });

  app.openapi(resolveIssueCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const existing = await stub.getComment(id);
    const issue = existing ? await stub.getIssue(issueId) : undefined;
    if (!existing || !issue || existing.entityId !== issue.id) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await assertIssueAccess(db, stub, issue, identity);
    const item = await stub.resolveComment(id, identity.id);
    return c.json(commentOut(item!));
  });

  app.openapi(unresolveIssueCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const existing = await stub.getComment(id);
    const issue = existing ? await stub.getIssue(issueId) : undefined;
    if (!existing || !issue || existing.entityId !== issue.id) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await assertIssueAccess(db, stub, issue, identity);
    const item = await stub.unresolveComment(id);
    return c.json(commentOut(item!));
  });
}

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  parseHandoffEvidence,
  parseHandoffOutputs,
} from "../agents/handoff.js";
import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { assertIssueAccess } from "./issue-access.js";
import { getWorkspaceStub } from "./stub.js";

// PILE-421 — structured handoffs between sub-step agents. A completing
// sub-step lane posts one record (step_key, typed outputs, next_agent,
// evidence links) which anchors on the parent issue; the next step's
// dispatch envelope renders the parent's handoffs, and a lane dispatched
// with requireHandoff cannot complete until its record exists. Posts are
// accepted from workspace writers AND from the completing lane's own
// per-session HMAC token (the api/index.ts bypass mints a lane:<sessionId>
// identity for it).

const handoffEvidenceSchema = z.object({
  /** Record kind the ref points at — document, attachment, issue, url, … */
  type: z.string().optional(),
  /** Document/attachment/issue id or a URL. */
  ref: z.string().min(1),
  label: z.string().optional(),
});

const handoffSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  /** Parent issue the handoff timeline anchors on. */
  issueId: z.string(),
  /** The sub-step issue the emitting session worked, when it differs. */
  fromIssueId: z.string().nullable(),
  sessionId: z.string(),
  stepKey: z.string(),
  nextAgent: z.string().nullable(),
  /** The step's typed outputs (template-defined shape). */
  outputs: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.array(handoffEvidenceSchema).nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

type HandoffRow = {
  id: string;
  organizationId: string;
  issueId: string;
  fromIssueId: string | null;
  sessionId: string;
  stepKey: string;
  nextAgent: string | null;
  outputs: string;
  evidence: string | null;
  createdBy: string | null;
  createdAt: string;
};

function toHandoffResponse(row: HandoffRow) {
  return {
    ...row,
    outputs: parseHandoffOutputs(row.outputs),
    evidence: row.evidence ? parseHandoffEvidence(row.evidence) : null,
  };
}

const createHandoffRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/handoffs",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  description:
    "Post the completing sub-step's handoff record — step_key, typed outputs, next_agent, evidence links. Anchors on the session's issue's parent unless issueId overrides. One per session: an identical retry returns the existing record, a divergent one 409s.",
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** Defaults to the session's stepKey. */
              stepKey: z.string().min(1).optional(),
              /** Anchor override — defaults to the session's issue's parent
               *  (or the issue itself when it has no parent). */
              issueId: z.string().optional(),
              nextAgent: z.string().optional(),
              /** The step's typed outputs — must be a JSON object. */
              outputs: z.record(z.string(), z.unknown()),
              evidence: z.array(handoffEvidenceSchema).optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Handoff recorded",
      content: { "application/json": { schema: handoffSchema } },
    },
    200: {
      description: "Identical handoff already recorded (idempotent replay)",
      content: { "application/json": { schema: handoffSchema } },
    },
    404: { description: "Session or anchor issue not found" },
    409: { description: "Session already posted a different handoff" },
  },
});

const listSessionHandoffsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/handoffs",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  description:
    "Handoffs the session posted (at most one — session_id is unique).",
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Session handoffs",
      content: {
        "application/json": {
          schema: z.object({ handoffs: z.array(handoffSchema) }),
        },
      },
    },
    404: { description: "Session not found" },
  },
});

const listIssueHandoffsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/handoffs",
  tags: ["issues"],
  middleware: [rls("issue:view")],
  description:
    "The handoff timeline for a parent issue — sub-step records in post order, optionally narrowed to one stepKey.",
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    query: z.object({ stepKey: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Issue handoff timeline",
      content: {
        "application/json": {
          schema: z.object({ handoffs: z.array(handoffSchema) }),
        },
      },
    },
    404: { description: "Issue not found" },
  },
});

export function registerHandoffRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createHandoffRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    // A lane token is bound to exactly one session — it cannot post a
    // handoff on a sibling lane's behalf.
    if (
      identity.id.startsWith("lane:") &&
      identity.id !== `lane:${sessionId}`
    ) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Lane tokens may only post handoffs for their own session",
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const prior = await stub.getHandoffForSession(sessionId);
    const handoff = await stub.createHandoff(
      sessionId,
      {
        stepKey: body.stepKey ?? null,
        issueId: body.issueId ?? null,
        nextAgent: body.nextAgent ?? null,
        outputs: body.outputs,
        evidence: body.evidence ?? null,
      },
      { actorId: identity.id, actorType: identity.type }
    );
    return c.json(
      toHandoffResponse(handoff),
      prior && prior.id === handoff.id ? 200 : 201
    );
  });

  app.openapi(listSessionHandoffsRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Session not found",
      });
    }
    const handoff = await stub.getHandoffForSession(sessionId);
    return c.json(
      { handoffs: handoff ? [toHandoffResponse(handoff)] : [] },
      200
    );
  });

  app.openapi(listIssueHandoffsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { stepKey } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const issue = await stub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, stub, issue, identity);
    const handoffs = await stub.listHandoffs({
      issueId: issue.id,
      ...(stepKey !== undefined ? { stepKey } : {}),
    });
    return c.json({ handoffs: handoffs.map(toHandoffResponse) }, 200);
  });
}

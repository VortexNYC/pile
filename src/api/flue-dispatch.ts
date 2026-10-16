import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { dispatchAgent } from "../agents/index.js";
import { VortexError } from "../platform/errors.js";
import { getWorkspaceStub } from "./stub.js";

// In-pile agent runtime — pile owns the agent. CfAgentProvider POSTs the
// registry profile + conversationKey here; the durable conversation is an
// agent_sessions row keyed by conversationKey ({merchantId}-{agentSlug}).

const dispatchBodySchema = z.object({
  sessionId: z.string().optional(),
  agent: z.string().optional(),
  organizationId: z.string(),
  issue: z
    .object({
      id: z.string(),
      identifier: z.string().nullable().optional(),
      title: z.string(),
      description: z.string().nullable().optional(),
      repo: z.string().nullable().optional(),
      branch: z.string().nullable().optional(),
      status: z.string().optional(),
      priority: z.number().optional(),
      labelIds: z.array(z.string()).optional(),
    })
    .passthrough(),
  profile: z
    .object({
      slug: z.string(),
      name: z.string(),
      jobSpec: z.string().nullable().optional(),
      toolScope: z.string().nullable().optional(),
      providerAgentId: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      prompt: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  conversationKey: z.string().nullable().optional(),
});

const dispatchPileRoute = createRoute({
  method: "post",
  path: "/dispatch/pile",
  tags: ["agents"],
  request: {
    body: {
      content: { "application/json": { schema: dispatchBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Dispatch admitted — conversationId is the session id",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            conversationId: z.string(),
          }),
        },
      },
    },
    401: { description: "Invalid dispatch token" },
  },
});

export function registerFlueDispatchRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(dispatchPileRoute, async (c) => {
    // Bearer auth — the same secret CfAgentProvider sends.
    const auth = c.req.header("Authorization") ?? "";
    const expected = c.env.AGENT_PROVIDER_TOKEN;
    if (!expected || auth !== `Bearer ${expected}`) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Missing or invalid dispatch token",
      });
    }
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, body.organizationId);
    const key = body.conversationKey ?? body.sessionId ?? crypto.randomUUID();

    // Resume: a session pinned to this conversation key already exists —
    // the new dispatch is a turn on the same conversation, not a new lane.
    const existing = await stub.getAgentSessionByConversationKey(key);
    if (existing) {
      await stub.addAgentActivity({
        sessionId: existing.id,
        type: "prompt",
        message: body.issue.title,
        payload: { issueId: body.issue.id, dispatch: true },
        system: true,
      });
      return c.json({ ok: true, conversationId: existing.id }, 200);
    }

    const session = await stub.createAgentSession({
      issueId: body.issue.id,
      agentId: body.profile?.slug ?? body.agent ?? "pile",
      provider: "flue",
      actorId: "flue-dispatch",
      actorType: "agent",
      status: "created",
      conversationKey: key,
      label: body.profile?.name ?? body.agent ?? "flue-agent",
      guidance: body.profile?.jobSpec ?? null,
    });
    // The session is the conversation anchor; the turn actually executes as
    // a pile lane on the executor provider (claude-cli by default — a real
    // headless run in the sandbox, not an external call).
    const executor =
      body.profile?.providerAgentId &&
      body.profile.providerAgentId !== "flue"
        ? body.profile.providerAgentId
        : "claude-cli";
    const instructions = [
      body.profile?.prompt ?? "",
      body.profile?.jobSpec ?? "",
      "",
      `Issue: ${body.issue.identifier ?? body.issue.id} — ${body.issue.title}`,
      body.issue.description ?? "",
    ]
      .filter((part) => part !== "")
      .join("\n");
    await stub.getIssue(body.issue.id).then(async (issue) => {
      if (!issue) return;
      await dispatchAgent(
        c.env,
        executor,
        body.organizationId,
        issue,
        {
          id: "flue-dispatch",
          type: "agent",
          organizationId: body.organizationId,
          permissions: ["admin"],
        },
        body.profile?.model ?? undefined,
        undefined,
        {
          instructions,
          conversationKey: key,
          agentProfile: body.profile
            ? {
                slug: body.profile.slug,
                name: body.profile.name,
                jobSpec: body.profile.jobSpec ?? null,
                toolScope: body.profile.toolScope ?? null,
              }
            : undefined,
        }
      ).catch((err: unknown) => {
        console.error("flue lane dispatch failed", {
          conversationKey: key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    return c.json({ ok: true, conversationId: session.id }, 200);
  });
}

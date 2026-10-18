import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { verifySessionToken } from "../agents/credentials.js";
import {
  LANE_TOOLS,
  allowedLaneTools,
  allowedWorkspaceLaneTools,
  createLaneGithub,
  laneToolAllowed,
  laneToolPolicy,
  laneToolPolicyForRepo,
  type LaneGithub,
  type LaneTool,
  type LaneToolContext,
  type LaneToolPermission,
  WORKSPACE_LANE_TOOLS,
  type WorkspaceLaneTool,
  type WorkspaceLaneToolContext,
} from "../agents/lane-tools.js";
import { pageChiefOfStaff } from "../agents/pipeline-events.js";
import type { SessionPlan } from "../agents/session-plan.js";
import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { organization } from "../global/schema.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { getWorkspaceStub } from "./stub.js";

const TERMINAL = new Set(["completed", "failed", "canceled"]);

async function orgMetadata(
  env: WorkerEnv,
  organizationId: string
): Promise<Record<string, unknown> | null> {
  const row = await createD1(env.D1)
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .get();
  try {
    const value: unknown = JSON.parse(row?.metadata ?? "");
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function lazyGithub(env: WorkerEnv, owner: string, name: string): LaneGithub {
  let client: Promise<LaneGithub> | null = null;
  const get = () => {
    client ??= getInstallationTokenForRepo(env, owner, name).then((token) => {
      if (!token) {
        throw new Error(`No installation token for ${owner}/${name}`);
      }
      return createLaneGithub(token);
    });
    return client;
  };
  return {
    request: async (...args) => (await get()).request(...args),
    text: async (...args) => (await get()).text(...args),
    graphql: async (...args) => (await get()).graphql(...args),
  };
}

/**
 * Lane MCP (PILE-284): purpose-built GitHub/lane tools for a running agent
 * session, authenticated by the per-session lane token. Only tools permitted
 * by the repo's lane tool policy are listed or callable, and every call is
 * recorded on the session event stream as `lane.tool`.
 */
export function registerLaneMcpRoutes(app: OpenAPIHono<AppContext>) {
  app.all(
    "/workspaces/:organizationId/agent/sessions/:sessionId/mcp",
    async (c) => {
      const { organizationId, sessionId } = c.req.param();
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      const stub = getWorkspaceStub(c.env, organizationId);
      const session = await stub.getAgentSession(sessionId);
      if (!session) return c.json({ message: "Session not found" }, 404);
      if (TERMINAL.has(session.status)) {
        return c.json({ message: "Session is terminal" }, 409);
      }
      const issue = await stub.getIssue(session.issueId);
      if (!issue) return c.json({ message: "Session issue not found" }, 404);

      // Profile allowlist — the agent type's `tools` field narrows the
      // policy by denying every registered tool it doesn't name. Absent or
      // unparseable means "tier governs" (no extra deny).
      const agentType = session.agentId
        ? await stub.getAgentTypeBySlug(session.agentId)
        : undefined;
      let profileDeny: string[] = [];
      if (agentType?.tools) {
        try {
          const allow: unknown = JSON.parse(agentType.tools);
          if (Array.isArray(allow)) {
            const names = new Set(
              allow.filter((t): t is string => typeof t === "string")
            );
            profileDeny = [...LANE_TOOLS, ...WORKSPACE_LANE_TOOLS]
              .map((t) => t.name)
              .filter((n) => !names.has(n));
          }
        } catch {
          /* malformed tools field — tier governs */
        }
      }

      const [owner, name] = (issue.repo ?? "").split("/");
      const repoScoped = Boolean(owner && name);
      const policy = repoScoped
        ? laneToolPolicyForRepo(
            await orgMetadata(c.env, organizationId),
            `${owner}/${name}`
          )
        : laneToolPolicy("pipeline", profileDeny);

      const branch = session.branch ?? issue.branch ?? `issue-${issue.id}`;
      const report = async (input: {
        message?: string;
        result?: string;
        prUrl?: string;
        plan?: SessionPlan;
      }) => {
        const now = new Date().toISOString();
        if (input.message !== undefined) {
          await stub.addAgentSessionEvent({
            sessionId,
            type: "log",
            message: input.message.slice(0, 2000),
          });
        }
        // PILE-426 — set_plan publishes the checklist on the session row
        // (event + progress-comment refresh ride along in the DO).
        if (input.plan !== undefined) {
          await stub.setAgentSessionPlan(sessionId, input.plan);
        }
        await stub.updateAgentSession(sessionId, {
          lastProgressAt: now,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
        });
      };

      const wsCtx: WorkspaceLaneToolContext = {
        ws: stub,
        env: c.env as unknown as Record<string, string | undefined>,
        organizationId,
        sessionId,
        issueId: issue.id,
        agentSlug: session.agentId ?? agentType?.slug ?? "lane",
        report,
        escalate: async (input) => {
          await pageChiefOfStaff(
            c.env,
            stub,
            organizationId,
            {
              event: "agent.escalated",
              issueId: issue.id,
              issueTitle: issue.title,
              issueIdentifier: issue.identifier,
              sessionId,
              agentSlug: session.agentId ?? agentType?.slug ?? "lane",
              conversationKey: session.conversationKey ?? null,
              question: input.context
                ? `${input.question}\n\n${input.context}`
                : input.question,
            },
            getExecutionCtx(c) ?? undefined
          );
        },
        policy,
      };
      const repoCtx: LaneToolContext | null = repoScoped
        ? {
            gh: lazyGithub(c.env, owner!, name!),
            owner: owner!,
            repo: name!,
            branch,
            policy,
            report,
          }
        : null;

      const server = new McpServer({ name: "pile-lane", version: "0.1.0" });
      const registerTool = <C>(
        tool: {
          name: string;
          description: string;
          permission: LaneToolPermission;
          inputSchema: z.ZodObject;
          run(ctx: C, input: unknown): Promise<unknown>;
        },
        ctx: C
      ) => {
        server.registerTool(
          tool.name,
          {
            description: `${tool.description} [permission: ${tool.permission}]`,
            inputSchema: tool.inputSchema,
          },
          async (args) => {
            // Re-check at call time: the listed set is the policy, but the
            // handler is the enforcement point.
            if (!laneToolAllowed(policy, tool)) {
              return {
                content: [
                  { type: "text" as const, text: "Tool not permitted" },
                ],
                isError: true,
              };
            }
            let text: string;
            let ok = true;
            try {
              const out = await tool.run(ctx, args);
              text = typeof out === "string" ? out : JSON.stringify(out);
            } catch (err) {
              ok = false;
              text = err instanceof Error ? err.message : String(err);
            }
            await stub
              .addAgentSessionEvent({
                sessionId,
                type: "lane.tool",
                message: `${tool.name}${ok ? "" : " (error)"}`,
                payload: { tool: tool.name, permission: tool.permission, ok },
              })
              .catch(() => {});
            return { content: [{ type: "text" as const, text }], isError: !ok };
          }
        );
      };
      if (repoCtx) {
        for (const tool of allowedLaneTools(policy)) {
          registerTool(tool as LaneTool, repoCtx);
        }
      }
      for (const tool of allowedWorkspaceLaneTools(policy)) {
        registerTool(tool as WorkspaceLaneTool, wsCtx);
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: false,
      });
      await server.connect(transport);
      return transport.handleRequest(c.req.raw);
    }
  );
}

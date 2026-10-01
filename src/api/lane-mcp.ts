import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";

import { verifySessionToken } from "../agents/credentials.js";
import {
  allowedLaneTools,
  createLaneGithub,
  laneToolAllowed,
  laneToolPolicyForRepo,
  type LaneGithub,
  type LaneToolContext,
} from "../agents/lane-tools.js";
import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { organization } from "../global/schema.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
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
      const [owner, name] = (issue?.repo ?? "").split("/");
      if (!issue || !owner || !name) {
        return c.json({ message: "Session issue has no repository" }, 422);
      }
      const branch = session.branch ?? issue.branch ?? `issue-${issue.id}`;
      const policy = laneToolPolicyForRepo(
        await orgMetadata(c.env, organizationId),
        `${owner}/${name}`
      );

      const ctx: LaneToolContext = {
        gh: lazyGithub(c.env, owner, name),
        owner,
        repo: name,
        branch,
        policy,
        async report(input) {
          const now = new Date().toISOString();
          if (input.message !== undefined) {
            await stub.addAgentSessionEvent({
              sessionId,
              type: "log",
              message: input.message.slice(0, 2000),
            });
          }
          await stub.updateAgentSession(sessionId, {
            lastProgressAt: now,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
          });
        },
      };

      const server = new McpServer({ name: "pile-lane", version: "0.1.0" });
      for (const tool of allowedLaneTools(policy)) {
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

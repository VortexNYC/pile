import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WorkerEnv } from "../api/middleware.js";

async function getStub(env: WorkerEnv, workspaceId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
  );
  await stub.setWorkspaceId(workspaceId);
  return stub;
}

export async function handleMcpRequest(request: Request, env: WorkerEnv) {
  const server = new McpServer({
    name: "issuetracker",
    version: "0.1.0",
  });

  server.registerTool(
    "list_issues",
    {
      description: "List issues in a workspace",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
      },
    },
    async (args) => {
      const workspaceId = args.workspaceId as string;
      const stub = await getStub(env, workspaceId);
      const issues = await stub.listIssues();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ issues }),
          },
        ],
      };
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedOrigins: ["*"],
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

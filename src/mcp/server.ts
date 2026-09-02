import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { MCP_TOOLS } from "./mcp-tools.js";
import type { WorkerEnv } from "../api/middleware.js";

type HonoApp = {
  fetch(
    request: Request,
    env?: WorkerEnv,
    executionCtx?: unknown
  ): Response | Promise<Response>;
};

type JsonSchemaInput = Parameters<typeof fromJsonSchema>[0];

const validator = new CfWorkerJsonSchemaValidator();

const TOOLS = MCP_TOOLS.map((tool) => ({
  ...tool,
  schema: fromJsonSchema(tool.inputSchema as JsonSchemaInput, validator),
}));

function fillPath(path: string, input: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = input[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

export async function handleMcpRequest(
  request: Request,
  env: WorkerEnv,
  app: HonoApp
) {
  const server = new McpServer({
    name: "issuetracker",
    version: "0.1.0",
  });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args) => {
        const input = args as Record<string, unknown>;
        const path = fillPath(tool.path, input);

        const query = new URLSearchParams();
        const pathParamNames = new Set(
          [...tool.path.matchAll(/\{([^}]+)\}/gu)].map((m) => m[1])
        );
        for (const [key, value] of Object.entries(input)) {
          if (key === "body" || pathParamNames.has(key)) continue;
          if (value !== undefined) query.set(key, String(value));
        }

        const url = new URL(request.url);
        const queryString = query.toString();
        const targetPath = queryString ? `${path}?${queryString}` : path;

        const headers = new Headers();
        const auth = request.headers.get("authorization");
        if (auth !== null) headers.set("authorization", auth);
        const workspaceHeader = request.headers.get("x-workspace-id");
        if (workspaceHeader !== null)
          headers.set("x-workspace-id", workspaceHeader);

        const body = input.body;
        const bodyText =
          body !== undefined ? JSON.stringify(body) : undefined;
        if (bodyText !== undefined) {
          headers.set("content-type", "application/json");
        }

        const proxyReq = new Request(`${url.origin}${targetPath}`, {
          method: tool.method,
          headers,
          body: bodyText,
        });

        const response = await app.fetch(proxyReq, env);
        const text = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text,
            },
          ],
          isError: !response.ok,
        };
      }
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

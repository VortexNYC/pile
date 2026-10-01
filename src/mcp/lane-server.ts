import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

import { callLaneTool, laneToolsForTier } from "../agents/lane-tools.js";
import type { LaneToolContext } from "../agents/lane-tools.js";

/**
 * Per-lane MCP server: registers only the tools the lane's tier grants, and
 * every call still goes through callLaneTool's capability check.
 */
export async function handleLaneMcpRequest(
  request: Request,
  ctx: LaneToolContext
): Promise<Response> {
  const server = new McpServer({ name: "pile-lane", version: "0.1.0" });

  for (const tool of laneToolsForTier(ctx.tier)) {
    server.registerTool(
      tool.name,
      {
        description: `${tool.description} Requires ${tool.capability}.`,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (args) => {
        const result = await callLaneTool(ctx, tool.name, args);
        return {
          content: [{ type: "text" as const, text: result.text }],
          isError: !result.ok,
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

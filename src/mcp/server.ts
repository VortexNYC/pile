import {
  fromJsonSchema,
  McpServer,
  ResourceTemplate,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";

import type { WorkerEnv } from "../platform/middleware.js";
import { aliasesFor, MCP_TOOL_ALIASES } from "./mcp-aliases.js";
import { MCP_TOOLS } from "./mcp-tools.js";

type HonoApp = {
  fetch(
    request: Request,
    env?: WorkerEnv,
    executionCtx?: unknown
  ): Response | Promise<Response>;
};

type JsonSchemaInput = Parameters<typeof fromJsonSchema>[0];

const validator = new CfWorkerJsonSchemaValidator();

const GENERATED_TOOLS = MCP_TOOLS.map((tool) => {
  const aliases = aliasesFor(tool.name);
  return {
    ...tool,
    description:
      aliases.length > 0
        ? `${tool.description} Alias: ${aliases.join(", ")}.`
        : tool.description,
    schema: fromJsonSchema(tool.inputSchema as JsonSchemaInput, validator),
  };
});

const GENERATED_BY_NAME = new Map(
  MCP_TOOLS.map((tool, index) => [tool.name, index] as const)
);

const ALIAS_TOOLS = Object.entries(MCP_TOOL_ALIASES).map(([alias, target]) => {
  const index = GENERATED_BY_NAME.get(target);
  if (index === undefined) {
    throw new Error(`MCP alias ${alias} points at unknown tool ${target}`);
  }
  const generated = GENERATED_TOOLS[index];
  return {
    ...generated,
    name: alias,
    description: `${MCP_TOOLS[index].description} Same as ${target}.`,
  };
});

const TOOLS = [...GENERATED_TOOLS, ...ALIAS_TOOLS];

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
    name: "pile",
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
        const bodyText = body !== undefined ? JSON.stringify(body) : undefined;
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

  const proxyResource = async (
    section: "agent-context" | "agent-context/rules" | "agent-context/skills",
    organizationId: string,
    mimeType: string
  ) => {
    const url = new URL(request.url);
    const headers = new Headers();
    const auth = request.headers.get("authorization");
    if (auth !== null) headers.set("authorization", auth);
    const workspaceHeader = request.headers.get("x-workspace-id");
    if (workspaceHeader !== null)
      headers.set("x-workspace-id", workspaceHeader);

    const proxyReq = new Request(
      `${url.origin}/workspaces/${encodeURIComponent(organizationId)}/${section}`,
      { method: "GET", headers }
    );
    const response = await app.fetch(proxyReq, env);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Agent context request failed: ${response.status}`);
    }
    let body = text;
    if (section === "agent-context") {
      const parsed = JSON.parse(text) as { agentsMd?: string };
      body = parsed.agentsMd ?? "";
    }
    return {
      contents: [
        {
          uri: `pile://workspaces/${organizationId}/${section}`,
          mimeType,
          text: body,
        },
      ],
    };
  };

  server.registerResource(
    "agent-context",
    new ResourceTemplate("pile://workspaces/{organizationId}/agent-context", {
      list: undefined,
    }),
    {
      description:
        "Workspace agent context (AGENTS.md) — the workspace's agent operating notes.",
      mimeType: "text/markdown",
    },
    async (_uri, variables) =>
      proxyResource(
        "agent-context",
        String(variables.organizationId),
        "text/markdown"
      )
  );

  server.registerResource(
    "agent-context-rules",
    new ResourceTemplate(
      "pile://workspaces/{organizationId}/agent-context/rules",
      { list: undefined }
    ),
    {
      description: "Workspace always-on agent rules (.devin/rules equivalent).",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyResource(
        "agent-context/rules",
        String(variables.organizationId),
        "application/json"
      )
  );

  server.registerResource(
    "agent-context-skills",
    new ResourceTemplate(
      "pile://workspaces/{organizationId}/agent-context/skills",
      { list: undefined }
    ),
    {
      description: "Workspace agent skill catalog (.devin/skills equivalent).",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyResource(
        "agent-context/skills",
        String(variables.organizationId),
        "application/json"
      )
  );

  // PILE-630 — entity resources proxy the workspace REST API so MCP clients
  // can read issues, documents, customers, and memory profiles by URI.
  const proxyJsonResource = async (apiPath: string, uri: string) => {
    const url = new URL(request.url);
    const headers = new Headers();
    const auth = request.headers.get("authorization");
    if (auth !== null) headers.set("authorization", auth);
    const workspaceHeader = request.headers.get("x-workspace-id");
    if (workspaceHeader !== null)
      headers.set("x-workspace-id", workspaceHeader);

    const proxyReq = new Request(`${url.origin}${apiPath}`, {
      method: "GET",
      headers,
    });
    const response = await app.fetch(proxyReq, env);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Resource request failed: ${response.status}`);
    }
    return {
      contents: [{ uri, mimeType: "application/json", text }],
    };
  };

  server.registerResource(
    "issue",
    new ResourceTemplate("pile://workspaces/{organizationId}/issues/{id}", {
      list: undefined,
    }),
    {
      description: "A workspace issue (bug, task, or epic) as JSON.",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyJsonResource(
        `/workspaces/${encodeURIComponent(String(variables.organizationId))}/issues/${encodeURIComponent(String(variables.id))}`,
        String(_uri)
      )
  );

  server.registerResource(
    "document",
    new ResourceTemplate("pile://workspaces/{organizationId}/documents/{id}", {
      list: undefined,
    }),
    {
      description: "A workspace document (notes, specs, handoffs) as JSON.",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyJsonResource(
        `/workspaces/${encodeURIComponent(String(variables.organizationId))}/documents/${encodeURIComponent(String(variables.id))}`,
        String(_uri)
      )
  );

  server.registerResource(
    "customer",
    new ResourceTemplate("pile://workspaces/{organizationId}/customers/{id}", {
      list: undefined,
    }),
    {
      description: "A workspace customer (CRM merchant) as JSON.",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyJsonResource(
        `/workspaces/${encodeURIComponent(String(variables.organizationId))}/customers/${encodeURIComponent(String(variables.id))}`,
        String(_uri)
      )
  );

  server.registerResource(
    "memory-profile",
    new ResourceTemplate(
      "pile://workspaces/{organizationId}/memory/profile/{entityType}/{entityId}",
      { list: undefined }
    ),
    {
      description:
        "Entity memory profile — static facts, dynamic context, and grouped kinds.",
      mimeType: "application/json",
    },
    async (_uri, variables) =>
      proxyJsonResource(
        `/workspaces/${encodeURIComponent(String(variables.organizationId))}/memory/profile?entityType=${encodeURIComponent(String(variables.entityType))}&entityId=${encodeURIComponent(String(variables.entityId))}`,
        String(_uri)
      )
  );

  // PILE-630 — starter prompts give connectors opinionated playbooks that
  // orchestrate the standard tools for common agent workflows.
  server.registerPrompt(
    "triage-issue",
    {
      title: "Triage an issue",
      description:
        "Triage a workspace issue: fetch it, recall its memory profile and similar issues, then report and label.",
      argsSchema: {
        organizationId: z.string(),
        issueId: z.string(),
      },
    },
    async ({ organizationId, issueId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Triage issue ${issueId} in workspace ${organizationId}.`,
              `1. Call get_issue for ${issueId} to read the full report.`,
              `2. Call memory_profile with entityType "issue" and entityId "${issueId}" to recall everything the workspace already knows.`,
              `3. Call find_similar_issues to catch possible duplicates.`,
              `4. Post a triage report as a comment: summary, severity guess, duplicate links, and suggested labels.`,
              `5. Apply the labels you recommended and mark duplicates when confident.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "morning-brief",
    {
      title: "Workspace morning brief",
      description:
        "Summarize today's top-ranked leads, send-gate readiness, and the plays worth running.",
      argsSchema: {
        organizationId: z.string(),
      },
    },
    async ({ organizationId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Produce the morning brief for workspace ${organizationId}.`,
              `1. Call customer_morning_brief for ${organizationId}.`,
              `2. Inspect the top-ranked leads: who is send-gate ready, who is blocked and why.`,
              `3. Summarize the actionable plays: first touches to send, follow-ups due, and anything needing a human.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "session-handoff",
    {
      title: "Write a session handoff",
      description:
        "Distill durable facts from a session into workspace memory and a linked markdown document.",
      argsSchema: {
        organizationId: z.string(),
        issueId: z.string(),
        topic: z.string(),
      },
    },
    async ({ organizationId, issueId, topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Write a session handoff for ${issueId} in workspace ${organizationId} covering "${topic}".`,
              `1. Distill the durable facts from your work — decisions, root causes, lessons, outcomes — and record them with memory_extract (or memory_remember for each fact).`,
              `2. Create a linked markdown document via create_document with title "${issueId} — ${topic}", contentFormat "markdown", and issueId "${issueId}" so the next session can pick it up.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "memory-distill",
    {
      title: "Distill an entity's memory",
      description:
        "Fetch an entity's memory profile and consolidate new durable facts with memory_extract.",
      argsSchema: {
        organizationId: z.string(),
        entityType: z.string(),
        entityId: z.string(),
      },
    },
    async ({ organizationId, entityType, entityId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Distill memory for ${entityType}:${entityId} in workspace ${organizationId}.`,
              `1. Call memory_profile with entityType "${entityType}" and entityId "${entityId}" to see the static facts and dynamic context already stored.`,
              `2. Run memory_extract over the relevant source (session, document, or issue) to pull out new durable facts.`,
              `3. Store each fact with memory_remember, keyed to ${entityType}:${entityId}, skipping anything the profile already covers.`,
            ].join("\n"),
          },
        },
      ],
    })
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}

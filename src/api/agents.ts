import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "../platform/middleware.js";
import { getWorkspaceStub } from "./stub.js";

const agentSkillSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.string().nullable(),
  outputSchema: z.string().nullable(),
  invoke: z.string(),
  enabled: z.boolean(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const httpInvokeSchema = z.object({
  type: z.literal("http"),
  method: z.string().default("POST"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpInvokeSchema = z.object({
  type: z.literal("mcp"),
  serverUrl: z.string(),
  tool: z.string(),
});

const skillBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.string().optional(),
  outputSchema: z.string().optional(),
  invoke: z.union([httpInvokeSchema, mcpInvokeSchema]),
  enabled: z.boolean().optional().default(true),
});

const agentConversationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string().nullable(),
  contextType: z.enum(["issue", "document", "project", "workspace"]).nullable(),
  contextId: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const conversationBodySchema = z.object({
  title: z.string().optional(),
  contextType: z.enum(["issue", "document", "project", "workspace"]).optional(),
  contextId: z.string().optional(),
});

const agentMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorId: z.string(),
  authorType: z.enum(["user", "agent"]),
  content: z.string(),
  contentFormat: z.enum(["text", "markdown", "blocks"]),
  toolCalls: z.string().nullable(),
  toolOutputs: z.string().nullable(),
  createdAt: z.string(),
});

const messageBodySchema = z.object({
  authorId: z.string(),
  authorType: z.enum(["user", "agent"]),
  content: z.string(),
  contentFormat: z.enum(["text", "markdown", "blocks"]).optional().default("text"),
  toolCalls: z.string().optional(),
  toolOutputs: z.string().optional(),
});

const skillInvokeBodySchema = z.object({
  input: z.record(z.string(), z.unknown()),
});

function toSkill(row: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  inputSchema: string | null;
  outputSchema: string | null;
  invoke: string;
  enabled: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return agentSkillSchema.parse({
    ...row,
    enabled: Boolean(row.enabled),
  });
}

export function registerAgentRoutes(app: OpenAPIHono<AppContext>) {
  const listSkillsRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/agent-skills",
    tags: ["agents"],
    middleware: [rls("read")],
    request: { params: z.object({ organizationId: z.string() }) },
    responses: {
      200: {
        description: "List agent skills",
        content: { "application/json": { schema: z.object({ skills: z.array(agentSkillSchema) }) } },
      },
    },
  });

  const createSkillRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/agent-skills",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: { content: { "application/json": { schema: skillBodySchema } } },
    },
    responses: {
      201: {
        description: "Skill created",
        content: { "application/json": { schema: agentSkillSchema } },
      },
    },
  });

  const getSkillRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/agent-skills/{id}",
    tags: ["agents"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
    },
    responses: {
      200: {
        description: "Skill",
        content: { "application/json": { schema: agentSkillSchema } },
      },
    },
  });

  const updateSkillRoute = createRoute({
    method: "patch",
    path: "/workspaces/{organizationId}/agent-skills/{id}",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
      body: { content: { "application/json": { schema: skillBodySchema.partial() } } },
    },
    responses: {
      200: {
        description: "Skill updated",
        content: { "application/json": { schema: agentSkillSchema } },
      },
    },
  });

  const deleteSkillRoute = createRoute({
    method: "delete",
    path: "/workspaces/{organizationId}/agent-skills/{id}",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
    },
    responses: { 204: { description: "Deleted" } },
  });

  const invokeSkillRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/agent-skills/{id}/invoke",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
      body: { content: { "application/json": { schema: skillInvokeBodySchema } } },
    },
    responses: {
      200: {
        description: "Invocation result",
        content: { "application/json": { schema: z.object({ ok: z.boolean(), status: z.number().optional(), body: z.unknown(), error: z.string().optional() }) } },
      },
    },
  });

  const listConversationsRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/agent-conversations",
    tags: ["agents"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string() }),
      query: z.object({
        contextType: z.enum(["issue", "document", "project", "workspace"]).optional(),
        contextId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Conversations",
        content: { "application/json": { schema: z.object({ conversations: z.array(agentConversationSchema) }) } },
      },
    },
  });

  const createConversationRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/agent-conversations",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string() }),
      body: { content: { "application/json": { schema: conversationBodySchema } } },
    },
    responses: {
      201: {
        description: "Conversation created",
        content: { "application/json": { schema: agentConversationSchema } },
      },
    },
  });

  const getConversationRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/agent-conversations/{id}",
    tags: ["agents"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
    },
    responses: {
      200: {
        description: "Conversation",
        content: {
          "application/json": {
            schema: z.object({ conversation: agentConversationSchema, messages: z.array(agentMessageSchema) }),
          },
        },
      },
    },
  });

  const updateConversationRoute = createRoute({
    method: "patch",
    path: "/workspaces/{organizationId}/agent-conversations/{id}",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
      body: { content: { "application/json": { schema: conversationBodySchema.partial().extend({ status: z.enum(["open", "closed"]).optional() }) } } },
    },
    responses: {
      200: {
        description: "Conversation updated",
        content: { "application/json": { schema: agentConversationSchema } },
      },
    },
  });

  const deleteConversationRoute = createRoute({
    method: "delete",
    path: "/workspaces/{organizationId}/agent-conversations/{id}",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
    },
    responses: { 204: { description: "Deleted" } },
  });

  const createMessageRoute = createRoute({
    method: "post",
    path: "/workspaces/{organizationId}/agent-conversations/{id}/messages",
    tags: ["agents"],
    middleware: [rls("write")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
      body: { content: { "application/json": { schema: messageBodySchema } } },
    },
    responses: {
      201: {
        description: "Message created",
        content: { "application/json": { schema: agentMessageSchema } },
      },
    },
  });

  const listMessagesRoute = createRoute({
    method: "get",
    path: "/workspaces/{organizationId}/agent-conversations/{id}/messages",
    tags: ["agents"],
    middleware: [rls("read")],
    request: {
      params: z.object({ organizationId: z.string(), id: z.string() }),
    },
    responses: {
      200: {
        description: "Messages",
        content: { "application/json": { schema: z.object({ messages: z.array(agentMessageSchema) }) } },
      },
    },
  });

  app.openapi(listSkillsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const skills = await stub.listAgentSkills();
    return c.json({ skills: skills.map(toSkill) });
  });

  app.openapi(createSkillRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const skill = await stub.createAgentSkill({ ...input, createdById: identity.id });
    return c.json(toSkill(skill), 201);
  });

  app.openapi(getSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const skill = await stub.getAgentSkill(id);
    if (!skill) {
      throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Skill not found" });
    }
    return c.json(toSkill(skill));
  });

  app.openapi(updateSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const skill = await stub.updateAgentSkill(id, input);
    if (!skill) {
      throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Skill not found" });
    }
    return c.json(toSkill(skill));
  });

  app.openapi(deleteSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.deleteAgentSkill(id);
    return c.body(null, 204);
  });

  app.openapi(invokeSkillRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { input } = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const result = await stub.invokeAgentSkill(id, input);
    return c.json(result);
  });

  app.openapi(listConversationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { contextType, contextId } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const conversations = await stub.listAgentConversations({ contextType, contextId });
    return c.json({ conversations });
  });

  app.openapi(createConversationRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const conversation = await stub.createAgentConversation(input);
    return c.json(conversation, 201);
  });

  app.openapi(getConversationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const conversation = await stub.getAgentConversation(id);
    if (!conversation) {
      throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Conversation not found" });
    }
    const messages = await stub.listAgentMessages(id);
    return c.json({ conversation, messages });
  });

  app.openapi(updateConversationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const conversation = await stub.updateAgentConversation(id, input);
    if (!conversation) {
      throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Conversation not found" });
    }
    return c.json(conversation);
  });

  app.openapi(deleteConversationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.deleteAgentConversation(id);
    return c.body(null, 204);
  });

  app.openapi(createMessageRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const conversation = await stub.getAgentConversation(id);
    if (!conversation) {
      throw new VortexError({ code: "NOT_FOUND", status: 404, message: "Conversation not found" });
    }
    const message = await stub.createAgentMessage({ ...input, conversationId: id });
    return c.json(message, 201);
  });

  app.openapi(listMessagesRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const messages = await stub.listAgentMessages(id);
    return c.json({ messages });
  });
}

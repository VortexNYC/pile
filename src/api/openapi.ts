import { Hono } from "hono";
import type { AppEnv } from "../platform/env.js";

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Vortex Issue Tracker",
    version: "0.1.0",
    description: "Agent-native issue tracker on Cloudflare Workers.",
  },
  servers: [
    {
      url: "https://your-domain.com",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["platform"],
        summary: "Health check",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/workspaces/{workspaceId}/issues": {
      get: {
        tags: ["issues"],
        summary: "List workspace issues",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Issues list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    issues: { type: "array" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["issues"],
        summary: "Create an issue",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  status: {
                    type: "string",
                    enum: [
                      "backlog",
                      "todo",
                      "in_progress",
                      "done",
                      "canceled",
                    ],
                  },
                  priority: {
                    type: "string",
                    enum: ["low", "medium", "high", "urgent"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Issue created" },
        },
      },
    },
    "/workspaces/{workspaceId}/issues/{id}": {
      get: {
        tags: ["issues"],
        summary: "Get an issue",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Issue" },
        },
      },
      patch: {
        tags: ["issues"],
        summary: "Update an issue",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  status: {
                    type: "string",
                    enum: [
                      "backlog",
                      "todo",
                      "in_progress",
                      "done",
                      "canceled",
                    ],
                  },
                  priority: {
                    type: "string",
                    enum: ["low", "medium", "high", "urgent"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Issue updated" },
        },
      },
    },
    "/workspaces/{workspaceId}/issues/{id}/dispatch": {
      post: {
        tags: ["agents"],
        summary: "Dispatch an agent to work on an issue",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "path",
            name: "id",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agentId: { type: "string" },
                  model: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Session created" },
        },
      },
    },
    "/workspaces/{workspaceId}/ws": {
      get: {
        tags: ["realtime"],
        summary: "WebSocket for realtime updates",
        parameters: [
          {
            in: "path",
            name: "workspaceId",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "101": { description: "WebSocket upgraded" },
        },
      },
    },
    "/github": {
      post: {
        tags: ["github"],
        summary: "GitHub pull_request webhook",
        responses: {
          "200": { description: "Webhook processed" },
        },
      },
    },
  },
};

const app = new Hono<{ Bindings: AppEnv }>();
app.get("/", (c) => c.json(spec));

export { app as openapiRoutes };

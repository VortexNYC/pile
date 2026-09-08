import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const pipelineSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  stages: z.array(z.string()),
  createdAt: z.string(),
});

const releaseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  projectId: z.string().nullable(),
  pipelineId: z.string().nullable(),
  stage: z.string().nullable(),
  status: z.string(),
  targetDate: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const pipelineBodySchema = z.object({
  name: z.string().min(1),
  stages: z.array(z.string()).optional(),
});

const createReleaseSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  projectId: z.string().optional(),
  pipelineId: z.string().optional(),
  stage: z.string().optional(),
  status: z.string().optional(),
  targetDate: z.string().optional(),
});

const updateReleaseSchema = createReleaseSchema.partial();

const orgParam = z.object({ organizationId: z.string() });
const orgIdParam = z.object({
  organizationId: z.string(),
  id: z.string(),
});

function notFound(message: string): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}

function toPipeline(row: {
  id: string;
  organizationId: string;
  name: string;
  stages: string;
  createdAt: string;
}) {
  return { ...row, stages: JSON.parse(row.stages) as string[] };
}

const listPipelinesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/release-pipelines",
  tags: ["releases"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Release pipelines",
      content: {
        "application/json": {
          schema: z.object({ pipelines: z.array(pipelineSchema) }),
        },
      },
    },
  },
});

const createPipelineRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/release-pipelines",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: pipelineBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Pipeline created",
      content: { "application/json": { schema: pipelineSchema } },
    },
  },
});

const deletePipelineRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/release-pipelines/{id}",
  tags: ["releases"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Pipeline deleted" },
    404: { description: "Pipeline not found" },
  },
});

const listReleasesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/releases",
  tags: ["releases"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: z.object({ projectId: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Releases",
      content: {
        "application/json": {
          schema: z.object({ releases: z.array(releaseSchema) }),
        },
      },
    },
  },
});

const createReleaseRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/releases",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: { "application/json": { schema: createReleaseSchema } },
    },
  },
  responses: {
    201: {
      description: "Release created",
      content: { "application/json": { schema: releaseSchema } },
    },
  },
});

const updateReleaseRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/releases/{id}",
  tags: ["releases"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: updateReleaseSchema } },
    },
  },
  responses: {
    200: {
      description: "Release updated",
      content: { "application/json": { schema: releaseSchema } },
    },
    404: { description: "Release not found" },
  },
});

const deleteReleaseRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/releases/{id}",
  tags: ["releases"],
  middleware: [rls("write")],
  request: { params: orgIdParam },
  responses: {
    204: { description: "Release deleted" },
    404: { description: "Release not found" },
  },
});

export function registerReleaseRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listPipelinesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listReleasePipelines();
    return c.json({ pipelines: rows.map(toPipeline) });
  });

  app.openapi(createPipelineRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json(toPipeline(await stub.createReleasePipeline(input)), 201);
  });

  app.openapi(deletePipelineRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteReleasePipeline(id)))
      return notFound("Pipeline not found");
    return c.body(null, 204);
  });

  app.openapi(listReleasesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { projectId } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ releases: await stub.listReleases({ projectId }) });
  });

  app.openapi(createReleaseRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const release = await stub.createRelease({
      ...input,
      createdById: identity.id,
    });
    return c.json(release, 201);
  });

  app.openapi(updateReleaseRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const release = await stub.updateRelease(id, input, identity.id);
    if (!release) return notFound("Release not found");
    return c.json(release);
  });

  app.openapi(deleteReleaseRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteRelease(id, identity.id)))
      return notFound("Release not found");
    return c.body(null, 204);
  });
}

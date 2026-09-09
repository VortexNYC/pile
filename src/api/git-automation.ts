import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const orgIdParam = z.object({ organizationId: z.string() });

const stateSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  stateId: z.string(),
  prState: z.string(),
  createdAt: z.string(),
});

const stateBodySchema = z.object({
  stateId: z.string(),
  prState: z.string(),
});

const targetBranchSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  pattern: z.string().nullable(),
  createdAt: z.string(),
});

const targetBranchBodySchema = z.object({
  name: z.string().min(1),
  pattern: z.string().optional(),
});

function notFound(message: string) {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}

const listStatesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/git-automation-states",
  tags: ["git-automation"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Git automation states",
      content: {
        "application/json": {
          schema: z.object({ states: z.array(stateSchema) }),
        },
      },
    },
  },
});

const createStateRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/git-automation-states",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: { content: { "application/json": { schema: stateBodySchema } } },
  },
  responses: {
    201: {
      description: "State created",
      content: { "application/json": { schema: stateSchema } },
    },
  },
});

const getStateRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/git-automation-states/{id}",
  tags: ["git-automation"],
  middleware: [rls("read")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    200: {
      description: "State",
      content: { "application/json": { schema: stateSchema } },
    },
    404: { description: "State not found" },
  },
});

const updateStateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/git-automation-states/{id}",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam.merge(z.object({ id: z.string() })),
    body: { content: { "application/json": { schema: stateBodySchema.partial() } } },
  },
  responses: {
    200: {
      description: "State updated",
      content: { "application/json": { schema: stateSchema } },
    },
    404: { description: "State not found" },
  },
});

const deleteStateRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/git-automation-states/{id}",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    204: { description: "State deleted" },
    404: { description: "State not found" },
  },
});

const listBranchesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/git-automation-target-branches",
  tags: ["git-automation"],
  middleware: [rls("read")],
  request: { params: orgIdParam },
  responses: {
    200: {
      description: "Target branches",
      content: {
        "application/json": {
          schema: z.object({ branches: z.array(targetBranchSchema) }),
        },
      },
    },
  },
});

const createBranchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/git-automation-target-branches",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam,
    body: {
      content: { "application/json": { schema: targetBranchBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Target branch created",
      content: { "application/json": { schema: targetBranchSchema } },
    },
  },
});

const getBranchRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/git-automation-target-branches/{id}",
  tags: ["git-automation"],
  middleware: [rls("read")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    200: {
      description: "Target branch",
      content: { "application/json": { schema: targetBranchSchema } },
    },
    404: { description: "Target branch not found" },
  },
});

const updateBranchRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/git-automation-target-branches/{id}",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: {
    params: orgIdParam.merge(z.object({ id: z.string() })),
    body: {
      content: {
        "application/json": { schema: targetBranchBodySchema.partial() },
      },
    },
  },
  responses: {
    200: {
      description: "Target branch updated",
      content: { "application/json": { schema: targetBranchSchema } },
    },
    404: { description: "Target branch not found" },
  },
});

const deleteBranchRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/git-automation-target-branches/{id}",
  tags: ["git-automation"],
  middleware: [rls("write")],
  request: { params: orgIdParam.merge(z.object({ id: z.string() })) },
  responses: {
    204: { description: "Target branch deleted" },
    404: { description: "Target branch not found" },
  },
});

export function registerGitAutomationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listStatesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ states: await stub.listGitAutomationStates() });
  });

  app.openapi(createStateRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const state = await stub.createGitAutomationState(input);
    return c.json(state!, 201);
  });

  app.openapi(getStateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const state = await stub.getGitAutomationState(id);
    if (!state) notFound("State not found");
    return c.json(state!);
  });

  app.openapi(updateStateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const state = await stub.updateGitAutomationState(id, input);
    if (!state) notFound("State not found");
    return c.json(state!);
  });

  app.openapi(deleteStateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteGitAutomationState(id)))
      notFound("State not found");
    return c.body(null, 204);
  });

  app.openapi(listBranchesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ branches: await stub.listGitAutomationTargetBranches() });
  });

  app.openapi(createBranchRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const branch = await stub.createGitAutomationTargetBranch({
      name: input.name,
      pattern: input.pattern ?? null,
    });
    return c.json(branch!, 201);
  });

  app.openapi(getBranchRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const branch = await stub.getGitAutomationTargetBranch(id);
    if (!branch) notFound("Target branch not found");
    return c.json(branch!);
  });

  app.openapi(updateBranchRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const branch = await stub.updateGitAutomationTargetBranch(id, input);
    if (!branch) notFound("Target branch not found");
    return c.json(branch!);
  });

  app.openapi(deleteBranchRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteGitAutomationTargetBranch(id)))
      notFound("Target branch not found");
    return c.body(null, 204);
  });
}

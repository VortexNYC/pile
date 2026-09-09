import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const linkSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  url: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
});

const bodySchema = z.object({
  url: z.string().url(),
  label: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/external-links",
  tags: ["issue-external-links"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "External links",
      content: {
        "application/json": { schema: z.object({ links: z.array(linkSchema) }) },
      },
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/external-links",
  tags: ["issue-external-links"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    body: { content: { "application/json": { schema: bodySchema } } },
  },
  responses: {
    201: {
      description: "External link created",
      content: { "application/json": { schema: linkSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/external-links/{id}",
  tags: ["issue-external-links"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "External link",
      content: { "application/json": { schema: linkSchema } },
    },
    404: { description: "External link not found" },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/issues/{issueId}/external-links/{id}",
  tags: ["issue-external-links"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
    body: { content: { "application/json": { schema: bodySchema.partial() } } },
  },
  responses: {
    200: {
      description: "External link updated",
      content: { "application/json": { schema: linkSchema } },
    },
    404: { description: "External link not found" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{issueId}/external-links/{id}",
  tags: ["issue-external-links"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "External link deleted" },
    404: { description: "External link not found" },
  },
});

async function checkIssueAccess(
  env: WorkerEnv,
  db: ReturnType<typeof createD1>,
  organizationId: string,
  issueId: string,
  identity: { id: string; permissions: string[] }
) {
  const stub = getWorkspaceStub(env, organizationId);
  const issue = await stub.getIssue(issueId);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  const allowed = await canAccessTeam(db, issue.teamId, identity);
  if (!allowed) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "External link not found",
    });
  }
  return stub;
}

export function registerIssueExternalLinkRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await checkIssueAccess(c.env, db, organizationId, issueId, identity);
    const links = await stub.listExternalLinks({
      entityType: "issue",
      entityId: issueId,
    });
    return c.json({ links });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await checkIssueAccess(c.env, db, organizationId, issueId, identity);
    const link = await stub.createExternalLink(
      {
        entityType: "issue",
        entityId: issueId,
        url: input.url,
        label: input.label ?? null,
      },
      identity.id
    );
    return c.json(link!, 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await checkIssueAccess(c.env, db, organizationId, issueId, identity);
    const link = await stub.getExternalLink(id);
    if (!link || link.entityType !== "issue" || link.entityId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    return c.json(link);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await checkIssueAccess(c.env, db, organizationId, issueId, identity);
    const existing = await stub.getExternalLink(id);
    if (!existing || existing.entityType !== "issue" || existing.entityId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    const link = await stub.updateExternalLink(id, input, identity.id);
    return c.json(link!);
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = await checkIssueAccess(c.env, db, organizationId, issueId, identity);
    const existing = await stub.getExternalLink(id);
    if (!existing || existing.entityType !== "issue" || existing.entityId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    await stub.deleteExternalLink(id, identity.id);
    return c.body(null, 204);
  });
}

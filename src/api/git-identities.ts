import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const gitEmail = z
  .string()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "invalid email address");

const gitIdentitySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  repo: z.string(),
  name: z.string(),
  email: gitEmail,
  githubUsername: z.string().nullable(),
  signingKeyRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const gitIdentityInputSchema = z.object({
  repo: z.string(),
  name: z.string(),
  email: gitEmail,
  githubUsername: z.string().nullable().optional(),
  signingKeyRef: z.string().nullable().optional(),
});

const listIdentitiesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/git/identities",
  tags: ["git-identities"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Git identities",
      content: {
        "application/json": { schema: z.array(gitIdentitySchema) },
      },
    },
  },
});

const upsertIdentityRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/git/identities",
  tags: ["git-identities"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: gitIdentityInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Git identity saved",
      content: {
        "application/json": { schema: gitIdentitySchema },
      },
    },
  },
});

const deleteIdentityRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/git/identities/{id}",
  tags: ["git-identities"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Git identity deleted" },
    404: { description: "Git identity not found" },
  },
});

export function registerGitIdentityRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIdentitiesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listGitIdentities();
    return c.json(rows, 200);
  });

  app.openapi(upsertIdentityRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const created = await stub.upsertGitIdentity({
      repo: body.repo,
      name: body.name,
      email: body.email,
      githubUsername: body.githubUsername ?? null,
      signingKeyRef: body.signingKeyRef ?? null,
    });
    return c.json(created);
  });

  app.openapi(deleteIdentityRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getGitIdentity(id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Git identity not found",
      });
    }
    await stub.deleteGitIdentity(id);
    return c.body(null, 204);
  });
}

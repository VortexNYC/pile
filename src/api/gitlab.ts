import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { gitlabFetch } from "../global/gitlab-auth.js";
import {
  createGitlabInstallation,
  deleteGitlabInstallation,
  findGitlabInstallation,
  listGitlabInstallations,
} from "../global/gitlab-installations.js";
import {
  createGitlabUserMapping,
  findUserByGitlabUsername,
  listGitlabUsers,
} from "../global/gitlab-users.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const installSchema = z.object({
  projectId: z.string(),
  projectPath: z.string(),
  token: z.string(),
  webhookSecret: z.string().optional(),
});

const installResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectPath: z.string(),
  createdAt: z.string(),
});

const gitlabUserSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  gitlabUsername: z.string(),
  createdAt: z.string(),
});

const gitlabUserRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/gitlab/users",
  tags: ["gitlab"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string(),
            gitlabUsername: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "GitLab user mapping created",
      content: {
        "application/json": { schema: gitlabUserSchema },
      },
    },
  },
});

const gitlabUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/gitlab/users",
  tags: ["gitlab"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "GitLab user mappings",
      content: {
        "application/json": {
          schema: z.object({ users: z.array(gitlabUserSchema) }),
        },
      },
    },
  },
});

const gitlabInstallRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/gitlab/install",
  tags: ["gitlab"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: installSchema },
      },
    },
  },
  responses: {
    200: {
      description: "GitLab project installed",
      content: {
        "application/json": { schema: installResponseSchema },
      },
    },
  },
});

const gitlabInstallationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/gitlab/installations",
  tags: ["gitlab"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "GitLab installations",
      content: {
        "application/json": {
          schema: z.object({
            installations: z.array(installResponseSchema),
          }),
        },
      },
    },
  },
});

const gitlabInstallationDeleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/gitlab/installations/{id}",
  tags: ["gitlab"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Installation removed" },
  },
});

export function registerGitlabRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(gitlabUserRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { userId, gitlabUsername } = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await findUserByGitlabUsername(
      db,
      organizationId,
      gitlabUsername
    );
    if (existing) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "GitLab username already mapped",
      });
    }

    const mapping = await createGitlabUserMapping(
      db,
      organizationId,
      userId,
      gitlabUsername
    );
    return c.json(mapping, 201);
  });

  app.openapi(gitlabUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const users = await listGitlabUsers(db, organizationId);
    return c.json({ users });
  });

  app.openapi(gitlabInstallRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { projectId, projectPath, token, webhookSecret } =
      c.req.valid("json");

    const response = await gitlabFetch(
      c.env,
      token,
      `/projects/${encodeURIComponent(projectId)}`
    );
    if (!response.ok) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "GitLab API request failed",
      });
    }

    const raw: unknown = await response.json();
    const parsed = z
      .object({ id: z.union([z.string(), z.number()]) })
      .safeParse(raw);
    if (!parsed.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Invalid GitLab response",
      });
    }

    const db = createD1(c.env.D1);

    const existing = await findGitlabInstallation(
      db,
      organizationId,
      projectPath
    );
    if (existing) {
      await deleteGitlabInstallation(db, organizationId, existing.id);
    }

    const installation = await createGitlabInstallation(
      db,
      organizationId,
      String(parsed.data.id),
      projectPath,
      token,
      webhookSecret
    );

    if (!installation) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to create GitLab installation",
      });
    }

    return c.json(
      {
        id: installation.id,
        projectId: installation.projectId,
        projectPath: installation.projectPath,
        createdAt: installation.createdAt,
      },
      200
    );
  });

  app.openapi(gitlabInstallationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const installations = await listGitlabInstallations(db, organizationId);
    return c.json({
      installations: installations.map((i) => ({
        id: i.id,
        projectId: i.projectId,
        projectPath: i.projectPath,
        createdAt: i.createdAt,
      })),
    });
  });

  app.openapi(gitlabInstallationDeleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await listGitlabInstallations(db, organizationId);
    const match = existing.find((row) => row.id === id);
    if (!match) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Installation not found",
      });
    }
    await deleteGitlabInstallation(db, organizationId, id);
    return c.body(null, 204);
  });
}

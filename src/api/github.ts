import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getInstallationToken } from "../global/github-auth.js";
import {
  createGithubInstallation,
  deleteGithubInstallation,
  deleteGithubInstallationById,
  listGithubInstallations,
} from "../global/github-installations.js";
import {
  createGithubUserMapping,
  listGithubUsers,
} from "../global/github-users.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const installSchema = z.object({
  installationId: z.string(),
});

const installResponseSchema = z.object({
  repos: z.array(
    z.object({
      full_name: z.string(),
    })
  ),
});

const githubUserSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  githubLogin: z.string(),
  createdAt: z.string(),
});

const githubInstallationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  installationId: z.string(),
  repo: z.string(),
  createdAt: z.string(),
});

const githubUserRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/github/users",
  tags: ["github"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string(),
            githubLogin: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "GitHub user mapping created",
      content: {
        "application/json": { schema: githubUserSchema },
      },
    },
  },
});

const githubInstallRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/github/install",
  tags: ["github"],
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
      description: "Installed repositories",
      content: {
        "application/json": { schema: installResponseSchema },
      },
    },
  },
});

const githubUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/github/users",
  tags: ["github"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "GitHub user mappings",
      content: {
        "application/json": {
          schema: z.object({ users: z.array(githubUserSchema) }),
        },
      },
    },
  },
});

const githubInstallationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/github/installations",
  tags: ["github"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "GitHub installations",
      content: {
        "application/json": {
          schema: z.object({
            installations: z.array(githubInstallationSchema),
          }),
        },
      },
    },
  },
});

const githubInstallationDeleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/github/installations/{id}",
  tags: ["github"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Installation removed" },
  },
});

export function registerGithubRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(githubUserRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { userId, githubLogin } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const mapping = await createGithubUserMapping(
      db,
      organizationId,
      userId,
      githubLogin
    );
    return c.json(mapping, 201);
  });

  app.openapi(githubUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const users = await listGithubUsers(db, organizationId);
    return c.json({ users });
  });

  app.openapi(githubInstallRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { installationId } = c.req.valid("json");

    const token = await getInstallationToken(c.env, installationId);
    if (!token) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Unable to mint GitHub installation token",
      });
    }

    const response = await fetch(
      `https://api.github.com/installations/${installationId}/repositories`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!response.ok) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "GitHub API request failed",
      });
    }

    const raw: unknown = await response.json();
    const parsed = z
      .object({
        repositories: z.array(
          z.object({
            full_name: z.string(),
          })
        ),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Invalid GitHub response",
      });
    }

    const db = createD1(c.env.D1);
    await Promise.all(
      parsed.data.repositories.map(async (repo) => {
        await deleteGithubInstallation(db, repo.full_name);
        await createGithubInstallation(
          db,
          organizationId,
          installationId,
          repo.full_name
        );
      })
    );

    return c.json({ repos: parsed.data.repositories });
  });

  app.openapi(githubInstallationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const installations = await listGithubInstallations(db, organizationId);
    return c.json({ installations });
  });

  app.openapi(githubInstallationDeleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await listGithubInstallations(db, organizationId);
    const match = existing.find((row) => row.id === id);
    if (!match) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Installation not found",
      });
    }
    await deleteGithubInstallationById(db, organizationId, id);
    return c.body(null, 204);
  });
}

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getInstallationToken } from "../global/github-auth.js";
import {
  createGithubInstallation,
  deleteGithubInstallation,
} from "../global/github-installations.js";
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

const githubInstallRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/github/install",
  tags: ["github"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
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

export function registerGithubRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(githubInstallRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
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
          workspaceId,
          installationId,
          repo.full_name
        );
      })
    );

    return c.json({ repos: parsed.data.repositories });
  });
}

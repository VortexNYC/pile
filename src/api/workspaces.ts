import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import { deleteWorkspaceData } from "../global/deletion.js";
import { apikey, member, organization } from "../global/schema.js";
import { safeJSON } from "../global/team-metadata.js";
import { createTeam, getDefaultTeam, setDefaultTeam } from "../global/teams.js";
import {
  createWorkspace,
  getWorkspaceById,
  getWorkspaceBySlug,
  getWorkspaceMembership,
  listWorkspacesForUser,
} from "../global/workspaces.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import { toApiKeyWorkspaceIdentity } from "../platform/identity.js";
import {
  requireHumanSession,
  type AppContext,
} from "../platform/middleware.js";
import { captureProductEvent } from "../platform/posthog.js";
import { rls } from "../platform/rls.js";
import {
  getSessionUserId,
  sessionHeadersForAuthApi,
} from "../platform/session.js";
import { emitWorkspaceAudit } from "./audit-emit.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { getWorkspaceStub } from "./stub.js";

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  key: z.string().nullable(),
  ownerId: z.string(),
  defaultTeamId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// The global workspace auth middleware mounts on /workspaces/:organizationId/*,
// which does not match /workspaces/{id} or /workspaces/slug/{slug} — those reads
// were public. Apply the same Bearer-token-or-session-membership rule here.
const workspaceReadAccess = (param: "id" | "slug") =>
  createMiddleware<{
    Bindings: AppContext["Bindings"];
    Variables: AppContext["Variables"];
  }>(async (c, next) => {
    const db = createD1(c.env.D1);
    let organizationId = c.req.param(param) as string;
    if (param === "slug") {
      const workspace = await getWorkspaceBySlug(db, organizationId);
      if (!workspace) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Workspace not found",
        });
      }
      organizationId = workspace.id;
    }

    const token = (c.req.header("Authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (token) {
      const auth = await createAuth(c.env);
      const result: unknown = await auth.api
        .verifyApiKey({ body: { key: token } })
        .catch(() => null);
      if (
        !result ||
        typeof result !== "object" ||
        !("valid" in result) ||
        !result.valid ||
        !("key" in result) ||
        !result.key
      ) {
        throw new VortexError({
          code: "UNAUTHORIZED",
          status: 401,
          message: "Invalid or expired token",
        });
      }
      const identity = toApiKeyWorkspaceIdentity(result.key);
      if (identity.organizationId !== organizationId) {
        throw new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: "Token does not belong to this workspace",
        });
      }
      c.set("workspaceIdentity", identity);
      await next();
      return;
    }

    const userId = await getSessionUserId(c.env, c.req.raw);
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    const membership = await getWorkspaceMembership(db, organizationId, userId);
    if (!membership) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "User is not a member of this workspace",
      });
    }
    await next();
  });

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["workspaces"],
  middleware: [requireHumanSession],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            slug: z.string().min(1),
            key: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace created",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["workspaces"],
  middleware: [requireHumanSession],
  request: {},
  responses: {
    200: {
      description: "Workspaces list",
      content: {
        "application/json": {
          schema: z.object({ workspaces: z.array(workspaceSchema) }),
        },
      },
    },
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspaces/{id}",
  tags: ["workspaces"],
  middleware: [workspaceReadAccess("id")],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

const getWorkspaceBySlugRoute = createRoute({
  method: "get",
  path: "/workspaces/slug/{slug}",
  tags: ["workspaces"],
  middleware: [workspaceReadAccess("slug")],
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

const deleteWorkspaceRoute = createRoute({
  method: "delete",
  path: "/workspaces/{id}",
  tags: ["workspaces"],
  middleware: [requireHumanSession],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description:
        "Workspace permanently deleted — every org-scoped D1 row, all R2 attachment objects, and the workspace Durable Object's storage.",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.boolean(),
            r2Objects: z.number(),
          }),
        },
      },
    },
    403: { description: "Requires owner or admin role in the workspace" },
    404: { description: "Workspace not found" },
  },
});

const updateWorkspaceRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}",
  tags: ["workspaces"],
  middleware: [requireHumanSession],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ssoEnforced: z.boolean().optional(),
            defaultTeamId: z.string().min(1).optional().openapi({
              description:
                "Team that receives issues created without a teamId. The previous default team becomes deletable.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workspace updated",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
    403: { description: "Requires owner or admin role in the workspace" },
    404: { description: "Workspace or default team not found" },
  },
});

const teamSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  key: z.string(),
  name: z.string(),
  ownerId: z.string(),
  isDefault: z.boolean(),
  isPublic: z.boolean(),
  parentAutoClose: z.boolean(),
  triageAssigneeId: z.string().nullable(),
  defaultTemplateId: z.string().nullable(),
  subIssueAutoClose: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const onboardWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces/onboard",
  tags: ["workspaces"],
  middleware: [requireHumanSession],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            slug: z.string().min(1),
            key: z.string().optional(),
            seedStarterIssues: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace onboarded with default team and admin token",
      content: {
        "application/json": {
          schema: z.object({
            workspace: workspaceSchema,
            team: teamSchema,
            token: z.string(),
            quickstart: z
              .object({
                mcpUrl: z.string(),
                cliSetupCommand: z.string(),
                seededIssueIds: z.array(z.string()),
              })
              .optional(),
          }),
        },
      },
    },
  },
});

const onboardingChecklistRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/onboarding-checklist",
  tags: ["workspaces"],
  middleware: [rls("settings:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Guided onboarding checklist state",
      content: {
        "application/json": {
          schema: z.object({
            organizationId: z.string(),
            hasApiKey: z.boolean(),
            hasAgentProvider: z.boolean(),
            hasFirstIssue: z.boolean(),
            mcpUrl: z.string(),
            pluginManifestUrl: z.string(),
          }),
        },
      },
    },
  },
});

export function registerWorkspaceRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createWorkspaceRoute, async (c) => {
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const ownerId = c.var.userId;
    if (!ownerId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Session required",
      });
    }
    const item = await createWorkspace(
      db,
      c.env,
      await sessionHeadersForAuthApi(c.env, c.req.raw.headers, ownerId),
      {
        name: input.name,
        slug: input.slug,
        key: input.key,
        ownerId,
      }
    );
    await emitWorkspaceAudit(
      c,
      item.id,
      "workspace.created",
      "workspace",
      item.id,
      {
        name: { from: null, to: item.name },
      }
    );
    captureProductEvent(
      "workspace.created",
      { organizationId: item.id, actorId: ownerId, slug: item.slug },
      getExecutionCtx(c),
      { env: c.env }
    );
    return c.json(item, 201);
  });

  app.openapi(listWorkspacesRoute, async (c) => {
    const db = createD1(c.env.D1);
    const userId = c.get("userId");
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    const items = await listWorkspacesForUser(db, userId);
    return c.json({ workspaces: items });
  });

  app.openapi(getWorkspaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getWorkspaceById(db, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateWorkspaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const userId = c.get("userId");
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    const workspace = await getWorkspaceById(db, id);
    if (!workspace) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    const membership = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, id), eq(member.userId, userId)))
      .get();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Requires owner or admin role in the workspace",
      });
    }
    if (input.ssoEnforced !== undefined) {
      const row = await db
        .select({ metadata: organization.metadata })
        .from(organization)
        .where(eq(organization.id, id))
        .get();
      const existing = safeJSON(row?.metadata ?? null);
      const metadata =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...existing, ssoEnforced: input.ssoEnforced }
          : { ssoEnforced: input.ssoEnforced };
      await db
        .update(organization)
        .set({ metadata: JSON.stringify(metadata) })
        .where(eq(organization.id, id));
      await emitWorkspaceAudit(c, id, "workspace.updated", "workspace", id, {
        ssoEnforced: { from: !input.ssoEnforced, to: input.ssoEnforced },
      });
    }
    if (input.defaultTeamId !== undefined) {
      const previous = await getDefaultTeam(db, id);
      // A no-op reassignment skips the batch entirely — no updatedAt churn,
      // no audit event.
      if (previous?.id !== input.defaultTeamId) {
        const next = await setDefaultTeam(db, id, input.defaultTeamId);
        if (!next) {
          throw new VortexError({
            code: "NOT_FOUND",
            status: 404,
            message: "Team not found",
          });
        }
        await emitWorkspaceAudit(c, id, "workspace.updated", "workspace", id, {
          defaultTeamId: { from: previous?.id ?? null, to: next.id },
        });
      }
    }
    const updated = await getWorkspaceById(db, id);
    if (!updated) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    return c.json(updated);
  });

  app.openapi(deleteWorkspaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const userId = c.get("userId");
    if (!userId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Authentication required",
      });
    }
    const workspace = await getWorkspaceById(db, id);
    if (!workspace) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    const membership = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, id), eq(member.userId, userId)))
      .get();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Requires owner or admin role in the workspace",
      });
    }
    const result = await deleteWorkspaceData(db, c.env, id);
    await emitWorkspaceAudit(c, id, "workspace.deleted", "workspace", id, {
      name: { from: workspace.name, to: null },
    });
    return c.json({ deleted: true, r2Objects: result.r2Objects });
  });

  app.openapi(getWorkspaceBySlugRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getWorkspaceBySlug(db, slug);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    return c.json(item);
  });

  app.openapi(onboardWorkspaceRoute, async (c) => {
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const ownerId = c.var.userId;
    if (!ownerId) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Session required",
      });
    }
    const workspace = await createWorkspace(
      db,
      c.env,
      await sessionHeadersForAuthApi(c.env, c.req.raw.headers, ownerId),
      {
        name: input.name,
        slug: input.slug,
        key: input.key,
        ownerId,
      }
    );
    // createWorkspace already provisions the default team through Better
    // Auth's organization hook; only fall back when it did not run. The
    // fallback goes through setDefaultTeam so the org metadata mirror is
    // written the same way as a reassignment.
    let team = await getDefaultTeam(db, workspace.id);
    if (!team) {
      const created = await createTeam(db, c.env, c.req.raw.headers, {
        organizationId: workspace.id,
        key: "general",
        name: "General",
        ownerId,
      });
      team = (await setDefaultTeam(db, workspace.id, created.id)) ?? created;
    }
    const auth = await createAuth(c.env);
    const keyResult = await auth.api.createApiKey({
      body: {
        userId: ownerId,
        name: "default-admin",
        rateLimitEnabled: false,
        metadata: {
          organizationId: workspace.id,
          permissions: "admin",
          actorType: "agent",
        },
        // Server-set grant — the identity layer trusts key permissions
        // only when they live here, not in client-controlled metadata.
        permissions: { workspace: ["admin"] },
      },
    });
    const parsed = z.object({ key: z.string() }).parse(keyResult);
    const execCtx = getExecutionCtx(c);
    captureProductEvent(
      "workspace.onboarded",
      { organizationId: workspace.id, actorId: ownerId, slug: workspace.slug },
      execCtx,
      { env: c.env }
    );
    captureProductEvent(
      "workspace.token_minted",
      { organizationId: workspace.id, actorId: ownerId, name: "default-admin" },
      execCtx,
      { env: c.env }
    );

    // PILE-639 — guided onboarding: seed two connect-your-agent issues and
    // hand the client a ready-to-paste MCP URL + CLI setup command.
    let quickstart:
      | { mcpUrl: string; cliSetupCommand: string; seededIssueIds: string[] }
      | undefined;
    if (input.seedStarterIssues && c.env.WORKSPACE_DURABLE_OBJECT) {
      const seededIssueIds: string[] = [];
      try {
        const stub = getWorkspaceStub(c.env, workspace.id);
        for (const title of [
          "Connect your coding agent via MCP or CLI",
          "Configure GitHub App and agent provider credentials",
        ]) {
          const issue = await stub.createIssue(
            {
              title,
              description:
                "Seeded by the onboarding flow — see docs/user-onboarding.md for the full quickstart.",
              status: "backlog",
              teamId: team.id,
            },
            ownerId
          );
          seededIssueIds.push(issue.id);
        }
      } catch {
        // Starter issues are best-effort — never block onboarding on them.
      }
      const origin = new URL(c.req.url).origin;
      quickstart = {
        mcpUrl: `${origin}/mcp`,
        cliSetupCommand: `pile config set --base-url ${origin} --api-key ${parsed.key}`,
        seededIssueIds,
      };
    }
    return c.json({ workspace, team, token: parsed.key, quickstart }, 201);
  });

  app.openapi(onboardingChecklistRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const origin = new URL(c.req.url).origin;

    const keyRow = await db
      .select({ id: apikey.id })
      .from(apikey)
      .where(
        sql`instr(${apikey.metadata}, ${`"organizationId":"${organizationId}"`}) > 0`
      )
      .get();

    // Provider credentials and the first issue live in the workspace DO.
    let hasAgentProvider = false;
    let hasFirstIssue = false;
    try {
      const stub = getWorkspaceStub(c.env, organizationId);
      const [providers, issues] = await Promise.all([
        stub.listAgentProviderConfigs().catch(() => [] as unknown[]),
        stub.listIssues({ limit: 1 }).catch(() => [] as unknown[]),
      ]);
      hasAgentProvider = (providers as unknown[]).length > 0;
      hasFirstIssue = (issues as unknown[]).length > 0;
    } catch {
      // Checklist is best-effort — a DO that cannot answer yet just shows
      // the unchecked state.
    }

    return c.json(
      {
        organizationId,
        hasApiKey: Boolean(keyRow),
        hasAgentProvider,
        hasFirstIssue,
        mcpUrl: `${origin}/mcp`,
        pluginManifestUrl: `${origin}/.well-known/mcp.json`,
      },
      200
    );
  });
}

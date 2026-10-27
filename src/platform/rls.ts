import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { createD1 } from "../global/db.js";
import { projectMembers, projects } from "../global/schema.js";
import { VortexError } from "./errors.js";
import type { AppContext } from "./middleware.js";
import { canAccess } from "./permissions.js";

async function getProjectRole(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  projectId: string,
  userId: string
): Promise<"lead" | "member" | null> {
  const member = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      )
    )
    .get();
  if (member) {
    return member.role === "lead" ? "lead" : "member";
  }
  const project = await db
    .select({ leadId: projects.leadId })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.id, projectId)
      )
    )
    .get();
  if (project?.leadId === userId) {
    return "lead";
  }
  return null;
}

function expandProjectRoles(allowed: string[]): Set<string> {
  const roles = new Set<string>();
  for (const p of allowed) {
    if (!p.startsWith("project:")) continue;
    const suffix = p.slice("project:".length);
    if (suffix === "lead") {
      roles.add("lead");
    } else if (suffix === "member") {
      roles.add("lead");
      roles.add("member");
    }
  }
  return roles;
}

// Guests are members locked to the documents surface. Any
// workspace path outside documents/comments rejects them before
// the permission check.
const GUEST_PATH =
  /^\/workspaces\/[^/]+\/(documents|comments|states|members|shared|links|entities\/)\b/;

/** VTX-753 — every rls() middleware carries its allowed grant specs so the
 * route table can be reduced to a method+path → required-permissions map.
 * The MCP server reads that map to hide tools a caller's key can never
 * satisfy; enforcement stays here, the map only drives visibility. */
export const RLS_ALLOWED_SPECS: unique symbol = Symbol("pile.rls.allowedSpecs");

const ROUTE_PERMISSIONS = new Map<string, readonly string[]>();

/** Records the rls specs declared on a route config's middleware list.
 * Called once per `app.openapi` registration (see api/index.ts). */
export function collectRoutePermissions(route: {
  method?: unknown;
  path?: unknown;
  middleware?: unknown;
}): void {
  if (typeof route.method !== "string" || typeof route.path !== "string") {
    return;
  }
  const middleware = route.middleware;
  const list = Array.isArray(middleware)
    ? middleware
    : middleware === undefined
      ? []
      : [middleware];
  // Every tagged middleware is an independent AND gate — a caller must pass
  // each of them. Storing each middleware's spec list separately keeps that
  // semantics intact for consumers.
  const gates: string[][] = [];
  for (const mw of list) {
    if (typeof mw !== "function") continue;
    const specs = (mw as Record<symbol, unknown>)[RLS_ALLOWED_SPECS];
    if (Array.isArray(specs)) gates.push(specs);
  }
  if (gates.length === 0) return;
  ROUTE_PERMISSIONS.set(
    `${route.method.toUpperCase()} ${route.path}`,
    gates.flat()
  );
}

/** The rls grants declared for a route, or undefined when the route carries
 * no rls middleware (any authenticated workspace identity may call it). */
export function routePermissionsFor(
  method: string,
  path: string
): readonly string[] | undefined {
  return ROUTE_PERMISSIONS.get(`${method.toUpperCase()} ${path}`);
}

export function rls(...allowed: string[]) {
  return Object.assign(
    createMiddleware<AppContext>(async (c, next) => {
      const identity = c.var.workspaceIdentity;
      if (identity.role === "guest" && !GUEST_PATH.test(c.req.path)) {
        throw new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: "Guests may only access documents",
        });
      }
      if (canAccess(identity.permissions, "admin")) {
        await next();
        return;
      }

      const projectAllowed = allowed.filter(
        (p) => p === "project:lead" || p === "project:member"
      );
      if (projectAllowed.length > 0) {
        const organizationId = c.req.param("organizationId");
        const projectId = c.req.param("projectId") ?? c.req.param("id");
        if (!organizationId || !projectId) {
          throw new VortexError({
            code: "BAD_REQUEST",
            status: 400,
            message: "Missing organization or project id",
          });
        }
        const db = createD1(c.env.D1);
        const role = await getProjectRole(
          db,
          organizationId,
          projectId,
          identity.id
        );
        const allowedRoles = expandProjectRoles(allowed);
        if (role && allowedRoles.has(role)) {
          await next();
          return;
        }
        // VTX-771 — a failed project-role check used to hard-403 even when
        // the caller held an ordinary grant that was also listed (e.g.
        // `rls("project:lead", "project:edit")` never reached project:edit
        // for a plain member). Fall through to the resource check; only
        // short-circuit to 403 when the route is project-role-only.
        if (projectAllowed.length === allowed.length) {
          throw new VortexError({
            code: "FORBIDDEN",
            status: 403,
            message: `Required permission: ${allowed.join(" or ")}`,
          });
        }
      }

      // "resource:action" specs (issue:view, document:edit, …) check the
      // resource statement; bare legacy verbs (read/write/admin) check
      // the workspace statement.
      const has = allowed.some((p) => {
        const [resource, action] = p.includes(":")
          ? (p.split(":", 2) as [string, string])
          : (["workspace", p] as const);
        return canAccess(identity.permissions, action, resource);
      });
      if (!has) {
        throw new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: `Required permission: ${allowed.join(" or ")}`,
        });
      }
      await next();
    }),
    { [RLS_ALLOWED_SPECS]: allowed }
  );
}

/** Member self-service — the workspace identity middleware has already
 * bound a member-scoped identity; handlers key everything to
 * identity.id, so no resource statement applies. Used for
 * notifications and own view-preferences where rls("read") would
 * wrongly require workspace:read. */
export const selfService = createMiddleware<AppContext>(async (_c, next) => {
  await next();
});

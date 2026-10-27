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

export function rls(...allowed: string[]) {
  return createMiddleware<AppContext>(async (c, next) => {
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
  });
}

/** Member self-service — the workspace identity middleware has already
 * bound a member-scoped identity; handlers key everything to
 * identity.id, so no resource statement applies. Used for
 * notifications and own view-preferences where rls("read") would
 * wrongly require workspace:read. */
export const selfService = createMiddleware<AppContext>(async (_c, next) => {
  await next();
});

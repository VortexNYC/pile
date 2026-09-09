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
      and(eq(projects.organizationId, organizationId), eq(projects.id, projectId))
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

export function rls(...allowed: string[]) {
  return createMiddleware<AppContext>(async (c, next) => {
    const identity = c.var.workspaceIdentity;
    if (canAccess(identity.permissions, "admin")) {
      await next();
      return;
    }

    const projectAllowed = allowed.filter((p) => p.startsWith("project:"));
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
      const role = await getProjectRole(db, organizationId, projectId, identity.id);
      const allowedRoles = expandProjectRoles(allowed);
      if (role && allowedRoles.has(role)) {
        await next();
        return;
      }
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: `Required: ${allowed.join(" or ")}`,
      });
    }

    const has = allowed.some((p) => canAccess(identity.permissions, p));
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

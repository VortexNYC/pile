import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { projectMembers } from "./schema.js";

const now = () => new Date().toISOString();

export type ProjectMemberRole = "lead" | "member";

export async function listProjectMembers(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  return db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.projectId, projectId)
      )
    )
    .all();
}

export async function addProjectMember(
  db: D1Client,
  organizationId: string,
  projectId: string,
  userId: string,
  role: ProjectMemberRole = "member"
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projectMembers).values({
    id,
    organizationId,
    projectId,
    userId,
    role,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.id, id))
    .get();
}

export async function updateProjectMemberRole(
  db: D1Client,
  organizationId: string,
  id: string,
  role: ProjectMemberRole
) {
  await db
    .update(projectMembers)
    .set({ role, updatedAt: now() })
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.id, id)
      )
    );
  return db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.id, id))
    .get();
}

export async function removeProjectMember(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, organizationId),
        eq(projectMembers.id, id)
      )
    );
}

import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";

import type { workspaceTokens } from "../global/schema.js";
import { parsePermissionSet } from "./permissions.js";

export type WorkspaceToken = InferSelectModel<typeof workspaceTokens>;

export const workspaceIdentitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.union([z.literal("agent"), z.literal("user")]),
  permissions: z.array(z.string()),
});

export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

export function toWorkspaceIdentity(token: WorkspaceToken): WorkspaceIdentity {
  return workspaceIdentitySchema.parse({
    id: token.id,
    workspaceId: token.workspaceId,
    type: "agent",
    permissions: Array.from(parsePermissionSet(token.permissions)),
  });
}

const rolePermissionsMap = {
  owner: ["read", "write", "admin"],
  admin: ["read", "write", "admin"],
  member: ["read", "write"],
} as const;

export type WorkspaceRole = keyof typeof rolePermissionsMap;

export function toUserWorkspaceIdentity(
  userId: string,
  workspaceId: string,
  role: WorkspaceRole
): WorkspaceIdentity {
  return workspaceIdentitySchema.parse({
    id: userId,
    workspaceId,
    type: "user",
    permissions: [...rolePermissionsMap[role]],
  });
}

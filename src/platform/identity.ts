import { z } from "zod";

import { parsePermissionSet } from "./permissions.js";

export const workspaceIdentitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.union([z.literal("agent"), z.literal("user")]),
  permissions: z.array(z.string()),
});

export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

const apiKeyMetadataSchema = z.object({
  workspaceId: z.string(),
  permissions: z.string(),
});

const apiKeyResultSchema = z.object({
  id: z.string(),
  metadata: z.unknown(),
});

function parseApiKeyMetadata(metadata: unknown) {
  if (typeof metadata === "string") {
    return apiKeyMetadataSchema.parse(JSON.parse(metadata));
  }
  return apiKeyMetadataSchema.parse(metadata);
}

export function toApiKeyWorkspaceIdentity(input: unknown): WorkspaceIdentity {
  const key = apiKeyResultSchema.parse(input);
  const parsed = parseApiKeyMetadata(key.metadata);
  return workspaceIdentitySchema.parse({
    id: key.id,
    workspaceId: parsed.workspaceId,
    type: "agent",
    permissions: Array.from(parsePermissionSet(parsed.permissions)),
  });
}

const rolePermissionsMap = {
  owner: ["read", "write", "admin"],
  admin: ["read", "write", "admin"],
  member: ["read", "write"],
} as const;

export type WorkspaceRole = keyof typeof rolePermissionsMap;

const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);

export function toUserWorkspaceIdentity(
  userId: string,
  workspaceId: string,
  role: string
): WorkspaceIdentity {
  const parsedRole = workspaceRoleSchema.parse(role);
  return workspaceIdentitySchema.parse({
    id: userId,
    workspaceId,
    type: "user",
    permissions: [...rolePermissionsMap[parsedRole]],
  });
}

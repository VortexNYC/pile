import { z } from "zod";

import { adminRole, guestRole, memberRole, ownerRole } from "./access.js";
import { VortexError } from "./errors.js";
import { parsePermissionSet } from "./permissions.js";

export const workspaceIdentitySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.union([z.literal("agent"), z.literal("user")]),
  // Better Auth organization role (user identities only).
  role: z.string().optional(),
  permissions: z.array(z.string()),
});

export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;

const apiKeyMetadataSchema = z.object({
  organizationId: z.string(),
  permissions: z.string().default("read"),
  actorType: z.enum(["user", "agent"]).optional(),
});

const apiKeyResultSchema = z.object({
  id: z.string(),
  referenceId: z.string(),
  metadata: z.unknown(),
  // Better Auth apiKey plugin's native permissions field — the
  // canonical home for key grants (resource → actions).
  permissions: z.record(z.string(), z.array(z.string())).nullish(),
});

function parseApiKeyMetadata(metadata: unknown) {
  try {
    if (typeof metadata === "string") {
      return apiKeyMetadataSchema.parse(JSON.parse(metadata));
    }
    return apiKeyMetadataSchema.parse(metadata);
  } catch {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "API key is missing workspace metadata",
      hint: "Create the key with metadata.organizationId and metadata.permissions set.",
    });
  }
}

export function toApiKeyWorkspaceIdentity(input: unknown): WorkspaceIdentity {
  const keyResult = apiKeyResultSchema.safeParse(input);
  if (!keyResult.success) {
    throw VortexError.fromCode("UNAUTHORIZED");
  }
  const key = keyResult.data;
  const parsed = parseApiKeyMetadata(key.metadata);
  // Prefer the plugin's native permissions field; metadata.permissions
  // (legacy CSV) is the fallback so existing keys keep working.
  const granted = key.permissions?.workspace
    ? key.permissions.workspace
    : Array.from(parsePermissionSet(parsed.permissions));
  return workspaceIdentitySchema.parse({
    id: key.referenceId,
    organizationId: parsed.organizationId,
    type: parsed.actorType ?? "user",
    permissions: granted,
  });
}

// Better Auth `ac` roles are the single source of truth — a workspace
// identity's permissions are the `workspace` statements its member role
// authorizes. Unknown/future roles degrade to member, never wider.
export const roleMap = {
  owner: ownerRole,
  admin: adminRole,
  member: memberRole,
  guest: guestRole,
} as const;

export function rolePermissionsFor(role: string): readonly string[] {
  const roleObject = roleMap[role as keyof typeof roleMap];
  // Unknown roles are dynamic organizationRole rows — resolve caller-side.
  if (!roleObject) return [];
  return flattenStatements(roleObject.statements);
}

export function flattenStatements(
  statements: Record<string, readonly string[] | undefined>
): string[] {
  const flat: string[] = [];
  for (const [resource, actions] of Object.entries(statements)) {
    for (const action of actions ?? []) {
      flat.push(`${resource}:${action}`);
    }
  }
  return flat;
}

// Any BA role name is valid — builtins resolve via roleMap,
// custom roles resolve through the org's organizationRole rows.
export const workspaceRoleSchema = z.string();

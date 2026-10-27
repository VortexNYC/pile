import { z } from "zod";

import { adminRole, guestRole, memberRole, ownerRole } from "./access.js";
import { VortexError } from "./errors.js";

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

/** The workspace an API key is scoped to, or undefined when the key carries
 * no `metadata.organizationId` (an account-level key that cannot call
 * workspace routes). Non-throwing counterpart of
 * toApiKeyWorkspaceIdentity's metadata check — used by the MCP server to
 * decide which tools a key may see (VTX-753). */
export function apiKeyWorkspaceScope(input: unknown): string | undefined {
  const keyResult = apiKeyResultSchema.safeParse(input);
  if (!keyResult.success) return undefined;
  try {
    const metadata = keyResult.data.metadata;
    const parsed =
      typeof metadata === "string"
        ? apiKeyMetadataSchema.safeParse(JSON.parse(metadata))
        : apiKeyMetadataSchema.safeParse(metadata);
    return parsed.success ? parsed.data.organizationId : undefined;
  } catch {
    return undefined;
  }
}

export function toApiKeyWorkspaceIdentity(input: unknown): WorkspaceIdentity {
  const keyResult = apiKeyResultSchema.safeParse(input);
  if (!keyResult.success) {
    throw VortexError.fromCode("UNAUTHORIZED");
  }
  const key = keyResult.data;
  const parsed = parseApiKeyMetadata(key.metadata);
  // The plugin's `permissions` column is server-only — clients minting keys
  // through /api/auth/api-key/* get SERVER_ONLY_PROPERTY if they try to set
  // it — so a `workspace` grant there is trustworthy. `metadata` is
  // client-controlled: a key without a server grant resolves as a read-only
  // user identity regardless of what metadata.permissions/actorType claim,
  // and the membership clamp then constrains it to the owner's role.
  const granted = key.permissions?.workspace;
  return workspaceIdentitySchema.parse({
    id: key.referenceId,
    organizationId: parsed.organizationId,
    type: granted ? (parsed.actorType ?? "user") : "user",
    permissions: granted ?? ["read"],
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

import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { workspaceTokens } from "../global/schema.js";
import { parsePermissionSet } from "./permissions.js";

export type WorkspaceToken = InferSelectModel<typeof workspaceTokens>;

export const workspaceIdentitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.literal("agent"),
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

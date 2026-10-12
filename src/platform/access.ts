import { createAccessControl } from "better-auth/plugins/access";
import type { OrganizationOptions } from "better-auth/plugins/organization";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { z } from "zod";

import { safeJSON, teamMetadataString } from "../global/team-metadata.js";

// Workspace-level statements layered on Better Auth's defaults.
// `document` is the org-level doc policy: which actions a *role* may take
// on documents generally. Per-document instance grants live in the
// workspace DO (document_permissions) on top of this.
// Per-resource CRUD statements — the BA org-RBAC model. Every
// entity type in the product is a resource; roles bundle grants.
// `rls` checks "resource:action" on each route; `dynamicAccessControl`
// lets admins mint custom roles into organizationRole rows.
export const ac = createAccessControl({
  ...defaultStatements,
  issue: ["view", "create", "edit", "delete"],
  document: ["view", "create", "edit", "delete"],
  project: ["view", "create", "edit", "delete"],
  ticket: ["view", "create", "edit", "delete"],
  contact: ["view", "create", "edit", "delete"],
  customer: ["view", "create", "edit", "delete"],
  deal: ["view", "create", "edit", "delete"],
  session: ["view", "create", "edit", "delete"],
  comment: ["view", "create", "edit", "delete"],
  settings: ["view", "edit"],
  // Coarse legacy actions kept so un-migrated routes and old API
  // keys keep working while call sites move to resource:action.
  workspace: ["read", "write", "admin"],
} as const);

const CONTENT = ["view", "create", "edit", "delete"] as const;

export const ownerRole = ac.newRole({
  ...ownerAc.statements,
  issue: [...CONTENT],
  document: [...CONTENT],
  project: [...CONTENT],
  ticket: [...CONTENT],
  contact: [...CONTENT],
  customer: [...CONTENT],
  deal: [...CONTENT],
  session: [...CONTENT],
  comment: [...CONTENT],
  settings: ["view", "edit"],
  workspace: ["read", "write", "admin"],
});

export const adminRole = ac.newRole({
  ...adminAc.statements,
  issue: [...CONTENT],
  document: [...CONTENT],
  project: [...CONTENT],
  ticket: [...CONTENT],
  contact: [...CONTENT],
  customer: [...CONTENT],
  deal: [...CONTENT],
  session: [...CONTENT],
  comment: [...CONTENT],
  settings: ["view", "edit"],
  workspace: ["read", "write", "admin"],
});

export const memberRole = ac.newRole({
  ...memberAc.statements,
  issue: ["view", "create", "edit"],
  document: ["view", "create", "edit"],
  project: ["view", "create", "edit"],
  ticket: ["view", "create", "edit"],
  contact: ["view", "create", "edit"],
  customer: ["view", "create", "edit"],
  deal: ["view", "create", "edit"],
  session: ["view", "create", "edit"],
  comment: ["view", "create", "edit"],
  settings: ["view"],
  workspace: ["read", "write"],
});

// Guests are org members whose reach stops at the documents
// surface — they read/write docs (subject to per-doc grants)
// and nothing else. `rls` path-gates them on top.
export const guestRole = ac.newRole({
  document: ["view", "create", "edit"],
});

const workspaceMetadataSchema = z
  .object({
    key: z.string().nullable().optional(),
    defaultTeamId: z.string().nullable().optional(),
  })
  .passthrough();

function parseWorkspaceMetadata(raw: unknown): {
  key: string | null;
  defaultTeamId: string | null;
} {
  if (!raw) return { key: null, defaultTeamId: null };
  const parsed = workspaceMetadataSchema.safeParse(safeJSON(raw));
  return parsed.success
    ? {
        key: parsed.data.key ?? null,
        defaultTeamId: parsed.data.defaultTeamId ?? null,
      }
    : { key: null, defaultTeamId: null };
}

export const organizationOptions = {
  teams: {
    enabled: true,
    defaultTeam: {
      enabled: true,
      async customCreateDefaultTeam(organization, ctx) {
        if (!ctx) {
          throw new Error("customCreateDefaultTeam missing endpoint context");
        }

        const organizationId = z.string().parse(organization.id);
        const rawMetadata: unknown = organization.metadata;
        const meta = parseWorkspaceMetadata(rawMetadata);
        const workspaceKey = meta.key ?? "general";

        const requestBody: unknown = ctx.body;
        const sessionUserId = z
          .string()
          .safeParse(ctx.context.session?.user.id).data;
        const bodyUserId = z
          .object({ userId: z.string() })
          .safeParse(requestBody).data?.userId;
        const ownerId = sessionUserId ?? bodyUserId;
        if (!ownerId) {
          throw new Error(
            "customCreateDefaultTeam could not resolve the creating user"
          );
        }

        const now = new Date();
        const metadata = teamMetadataString({
          key: workspaceKey,
          ownerId,
          isDefault: true,
          isPublic: false,
        });

        const teamResultSchema = z
          .object({
            id: z.string(),
            name: z.string(),
            organizationId: z.string(),
            createdAt: z.coerce.date(),
            updatedAt: z.coerce.date().optional(),
            memberCount: z.coerce.number().optional(),
          })
          .passthrough();

        const created = teamResultSchema.parse(
          await ctx.context.adapter.create({
            model: "team",
            data: {
              name: "General",
              organizationId,
              memberCount: 0,
              metadata,
              createdAt: now,
              updatedAt: now,
            },
          })
        );

        const updatedMeta = {
          ...meta,
          defaultTeamId: created.id,
        };
        await ctx.context.adapter.update({
          model: "organization",
          where: [{ field: "id", value: organizationId }],
          update: {
            metadata: JSON.stringify(updatedMeta),
            updatedAt: now,
          },
        });

        return created;
      },
    },
  },
  ac,
  roles: {
    owner: ownerRole,
    admin: adminRole,
    member: memberRole,
    guest: guestRole,
  },
  dynamicAccessControl: { enabled: true },
} satisfies OrganizationOptions;

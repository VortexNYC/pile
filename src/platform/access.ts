import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { z } from "zod";

import { teamMetadataString } from "../global/team-metadata.js";

// Workspace-level statements layered on Better Auth's defaults.
// `document` is the org-level doc policy: which actions a *role* may take
// on documents generally. Per-document instance grants live in the
// workspace DO (document_permissions) on top of this.
export const ac = createAccessControl({
  ...defaultStatements,
  document: ["view", "edit"],
} as const);

export const ownerRole = ac.newRole({
  ...ownerAc.statements,
  document: ["view", "edit"],
});

export const adminRole = ac.newRole({
  ...adminAc.statements,
  document: ["view", "edit"],
});

export const memberRole = ac.newRole({
  ...memberAc.statements,
  document: ["view", "edit"],
});

const workspaceMetadataSchema = z
  .object({
    key: z.string().nullable().optional(),
    defaultTeamId: z.string().nullable().optional(),
  })
  .passthrough();

function parseWorkspaceMetadata(raw: unknown) {
  if (!raw) return { key: null, defaultTeamId: null };
  const parsed = workspaceMetadataSchema.safeParse(
    typeof raw === "string" ? JSON.parse(raw) : raw
  );
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
        const meta = parseWorkspaceMetadata(organization.metadata);
        const workspaceKey = meta.key ?? "general";
        const ownerId =
          ctx.context.session?.user.id ??
          z.object({ userId: z.string() }).safeParse(ctx.body).data?.userId ??
          "";
        const now = new Date();
        const metadata = teamMetadataString({
          key: workspaceKey,
          ownerId,
          isDefault: true,
          isPublic: false,
        });

        const team = await ctx.context.adapter.create({
          model: "team",
          data: {
            name: "General",
            organizationId: organization.id,
            memberCount: 0,
            metadata,
            createdAt: now,
            updatedAt: now,
          },
        });

        const updatedMeta = {
          ...meta,
          defaultTeamId: team.id,
        };
        await ctx.context.adapter.update({
          model: "organization",
          where: [{ field: "id", value: organization.id }],
          update: {
            metadata: JSON.stringify(updatedMeta),
            updatedAt: now,
          },
        });

        return team;
      },
    },
  },
  ac,
  roles: {
    owner: ownerRole,
    admin: adminRole,
    member: memberRole,
  },
  dynamicAccessControl: { enabled: true },
};

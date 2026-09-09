import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

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

export const organizationOptions = {
  teams: { enabled: true },
  ac,
  roles: {
    owner: ownerRole,
    admin: adminRole,
    member: memberRole,
  },
  dynamicAccessControl: { enabled: true },
} as const;

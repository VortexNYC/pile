import { createAccessControl } from "better-auth/plugins/access";

// Mirrors src/platform/access.ts — the BA ac statements and built-in
// roles the workspace uses. The client needs the same `ac` instance
// shape so organizationClient.checkRolePermission evaluates member
// roles identically to the server.
export const ac = createAccessControl({
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
  workspace: ["read", "write", "admin"],
} as const);

const CONTENT = ["view", "create", "edit", "delete"] as const;

export const ownerRole = ac.newRole({
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

export const guestRole = ac.newRole({
  document: ["view", "create", "edit"],
});

export const roles = {
  owner: ownerRole,
  admin: adminRole,
  member: memberRole,
  guest: guestRole,
} as const;

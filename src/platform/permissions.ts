import { flattenStatements, roleMap } from "./identity.js";

const ALL_WORKSPACE_ACTIONS = ["read", "write", "admin"] as const;

// BA role names ("member", "owner", ...) are accepted as grant shorthand —
// they expand to the role's flattened statements so e.g. a key minted with
// "member" actually carries the member permissions instead of parsing as
// an opaque string no check can satisfy (the console's Create key sends it).
const ROLE_GRANTS = new Map<string, readonly string[]>(
  Object.entries(roleMap).map(([name, role]) => [
    name,
    flattenStatements(role.statements),
  ])
);

export function parsePermissionSet(
  permissions: string | string[]
): Set<string> {
  const list = Array.isArray(permissions)
    ? permissions
    : permissions
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
  const expanded = new Set<string>();
  for (const p of list) {
    const grants = ROLE_GRANTS.get(p);
    if (grants) for (const g of grants) expanded.add(g);
    else expanded.add(p);
  }
  // The `*` grant is the admin wildcard — expand at parse so every
  // downstream check (canAccess + permissions.includes) sees it.
  if (expanded.has("*")) {
    expanded.delete("*");
    for (const action of ALL_WORKSPACE_ACTIONS) expanded.add(action);
  }
  return expanded;
}

/** Evaluate a permission grant through Better Auth's access-control
 * semantics — the `workspace` statement in `ac` (access.ts) defines
 * which actions exist; `admin`/`read`/`write` are actions on it and
 * `*` remains the wildcard the BA evaluator understands. */
/** Resource-scoped check — permissions are flat "resource:action"
 * strings (or legacy "read"/"write" on the workspace statement).
 * `canAccess(perms, "issue", "view")` answers whether the grant
 * covers the action; the old one-arg form still checks workspace. */
export function canAccess(
  permissions: string | string[],
  action: string,
  resource = "workspace"
): boolean {
  const set = parsePermissionSet(permissions);
  if (set.has("admin")) return true;
  if (resource === "workspace") {
    // Roles flatten to "workspace:read"; API keys store plain "read".
    return set.has(action) || set.has(`workspace:${action}`);
  }
  if (set.has(`${resource}:${action}`) || set.has(`${resource}:*`)) {
    return true;
  }
  // Legacy bare verbs are resource-wide grants — a "read" key views
  // every resource, "write" covers create/edit/delete.
  if (action === "view") return set.has("read") || set.has("write");
  if (action === "create" || action === "edit" || action === "delete") {
    return set.has("write");
  }
  return false;
}

/** Admin check over both forms — bare "admin" on API keys and
 * "workspace:admin" on flattened member identities. */
export function isAdminIdentity(identity: { permissions: string[] }): boolean {
  return canAccess(identity.permissions, "admin");
}

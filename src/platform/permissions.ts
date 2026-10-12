const ALL_WORKSPACE_ACTIONS = ["read", "write", "admin"] as const;

export function parsePermissionSet(
  permissions: string | string[]
): Set<string> {
  const list = Array.isArray(permissions)
    ? permissions
    : permissions
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
  // The `*` grant is the admin wildcard — expand at parse so every
  // downstream check (canAccess + permissions.includes) sees it.
  if (list.includes("*")) {
    return new Set([
      ...list.filter((p) => p !== "*"),
      ...ALL_WORKSPACE_ACTIONS,
    ]);
  }
  return new Set(list);
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

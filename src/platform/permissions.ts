import { role } from "better-auth/plugins/access";

export function parsePermissionSet(
  permissions: string | string[]
): Set<string> {
  const list = Array.isArray(permissions)
    ? permissions
    : permissions
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
  return new Set(list);
}

/** Evaluate a permission grant through Better Auth's access-control
 * semantics — the `workspace` statement in `ac` (access.ts) defines
 * which actions exist; `admin`/`read`/`write` are actions on it and
 * `*` remains the wildcard the BA evaluator understands. */
export function canAccess(
  permissions: string | string[],
  action: string
): boolean {
  const granted = role({
    workspace: Array.from(parsePermissionSet(permissions)),
  });
  return granted.authorize({ workspace: [action] }).success === true;
}

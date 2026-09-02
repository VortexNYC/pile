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

export function canAccess(
  permissions: string | string[],
  action: "read" | "write" | "admin"
): boolean {
  const set = parsePermissionSet(permissions);
  return set.has(action) || set.has("admin") || set.has("*");
}

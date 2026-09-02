export function parsePermissionSet(permissions: string): Set<string> {
  return new Set(
    permissions
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function canAccess(
  permissions: string,
  action: "read" | "write" | "admin"
): boolean {
  const set = parsePermissionSet(permissions);
  return set.has(action) || set.has("admin") || set.has("*");
}

export function parsePermissionSet(permissions: string): Set<string> {
  return new Set(
    permissions
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  );
}

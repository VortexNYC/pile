import { useQuery } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { ApiError } from "@/lib/api";

export type PermResource =
  | "issue"
  | "document"
  | "project"
  | "ticket"
  | "contact"
  | "customer"
  | "deal"
  | "session"
  | "comment"
  | "settings";
type PermAction = "view" | "create" | "edit" | "delete";

export interface MyPermissions {
  role: string | null;
  permissions: string[];
}

/** Fetch the caller's permission set. Throws on !ok — a failed read must
 * surface as a query error so consumers can show the error/retry path;
 * returning an empty grant set silently striped the UI down to nothing
 * for members (PILE-652). */
export async function fetchPermissions(
  organizationId: string
): Promise<MyPermissions> {
  const res = await fetch(`/workspaces/${organizationId}/me/permissions`);
  if (!res.ok) {
    throw new ApiError(
      `Permissions request failed (${res.status})`,
      res.status
    );
  }
  return (await res.json()) as MyPermissions;
}

/** Pure grant check — built-in roles AND dynamic organizationRole
 * statements, mirroring the server's `canAccess`. Callers that gate chrome
 * should still check `isLoaded` first: `undefined` data answers "no" for
 * every action, which is right for mutations but wrong for chrome that
 * should stay put while the query is in flight. */
export function permissionAllowed(
  data: MyPermissions | undefined,
  resource: PermResource,
  action: PermAction
): boolean {
  const role = data?.role ?? null;
  if (role === "owner" || role === "admin") return true;
  const set = new Set(data?.permissions ?? []);
  if (set.has("admin") || set.has("workspace:admin")) return true;
  if (set.has(`${resource}:${action}`) || set.has(`${resource}:*`)) {
    return true;
  }
  // Legacy bare verbs — "read" covers view, "write" covers mutations.
  if (action === "view") return set.has("read") || set.has("write");
  return set.has("write");
}

/** The member's flattened workspace permissions, resolved server-side
 * (built-in roles AND dynamic organizationRole statements). Mirrors the
 * API's permission model so the UI only surfaces what the backend would
 * let through. */
export function usePermissions(organizationId: string) {
  const perms = useQuery({
    queryKey: wsKey(organizationId, "my-permissions"),
    queryFn: () => fetchPermissions(organizationId),
    staleTime: 60_000,
  });

  const value = (perms.data?.role ?? null) as
    | "owner"
    | "admin"
    | "member"
    | "guest"
    | null;
  const isAdmin = value === "owner" || value === "admin";
  const can = (resource: PermResource, action: PermAction): boolean =>
    permissionAllowed(perms.data, resource, action);
  return {
    role: value,
    isAdmin,
    isGuest: value === "guest",
    can,
    isLoaded: perms.isSuccess,
  };
}

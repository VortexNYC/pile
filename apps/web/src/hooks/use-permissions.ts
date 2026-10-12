import { useQuery } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

type PermResource =
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

/** The member's flattened workspace permissions, resolved server-side
 * (built-in roles AND dynamic organizationRole statements). Mirrors the
 * API's permission model so the UI only surfaces what the backend would
 * let through. */
export function usePermissions(organizationId: string) {
  const role = useQuery({
    queryKey: wsKey(organizationId, "member-role"),
    queryFn: async () => {
      await betterAuthClient.organization.setActive({ organizationId });
      const result = await betterAuthClient.organization.getActiveMemberRole();
      return result.data?.role ?? null;
    },
    staleTime: 60_000,
  });
  const perms = useQuery({
    queryKey: wsKey(organizationId, "my-permissions"),
    queryFn: async () => {
      const res = await fetch(`/workspaces/${organizationId}/me/permissions`);
      if (!res.ok) return { permissions: [] as string[] };
      return (await res.json()) as { permissions: string[] };
    },
    staleTime: 60_000,
  });

  const value = (role.data ?? null) as
    | "owner"
    | "admin"
    | "member"
    | "guest"
    | null;
  const isAdmin = value === "owner" || value === "admin";
  const set = new Set(perms.data?.permissions ?? []);
  const can = (resource: PermResource, action: PermAction): boolean => {
    if (isAdmin) return true;
    if (set.has("admin") || set.has("workspace:admin")) return true;
    if (set.has(`${resource}:${action}`) || set.has(`${resource}:*`)) {
      return true;
    }
    // Legacy bare verbs — "read" covers view, "write" covers mutations.
    if (action === "view") return set.has("read") || set.has("write");
    return set.has("write");
  };
  return {
    role: value,
    isAdmin,
    isGuest: value === "guest",
    can,
    isLoaded: role.isSuccess && perms.isSuccess,
  };
}

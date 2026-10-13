import { useQuery } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";

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
  const perms = useQuery({
    queryKey: wsKey(organizationId, "my-permissions"),
    queryFn: async () => {
      const res = await fetch(`/workspaces/${organizationId}/me/permissions`);
      if (!res.ok) {
        return { role: null, permissions: [] as string[] };
      }
      return (await res.json()) as {
        role: string | null;
        permissions: string[];
      };
    },
    staleTime: 60_000,
  });

  const value = (perms.data?.role ?? null) as
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
    isLoaded: perms.isSuccess,
  };
}

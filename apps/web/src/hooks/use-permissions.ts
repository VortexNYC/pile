import { useQuery } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

/** Workspace role for the signed-in user — owner/admin are admins,
 * everyone else is a member. Mirrors the API's permission model so the
 * UI only surfaces what the backend would let through. */

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
  const value = (role.data ?? null) as
    | "owner"
    | "admin"
    | "member"
    | "guest"
    | null;
  const isAdmin = value === "owner" || value === "admin";
  // BA's checkRolePermission only knows built-in roles — custom roles
  // resolve their statements from the organizationRole rows.
  const BUILTINS = new Set(["owner", "admin", "member", "guest"]);
  const customRole = useQuery({
    queryKey: wsKey(organizationId, "org-role-def", value),
    enabled: value !== null && !BUILTINS.has(value),
    queryFn: async () => {
      const result = await betterAuthClient.$fetch(
        `/organization/list-roles?organizationId=${organizationId}`
      );
      const rows = (result.data ?? []) as {
        role: string;
        permission: string | Record<string, string[]>;
      }[];
      const row = rows.find((r) => r.role === value) ?? null;
      if (!row) return null;
      // organizationRole.permission is stored as JSON text.
      return {
        permission:
          typeof row.permission === 'string'
            ? (JSON.parse(row.permission) as Record<string, string[]>)
            : row.permission,
      };
    },
    staleTime: 60_000,
  });
  const can = (
    resource:
      | "issue"
      | "document"
      | "project"
      | "ticket"
      | "contact"
      | "customer"
      | "deal"
      | "session"
      | "comment"
      | "settings",
    action: "view" | "create" | "edit" | "delete"
  ): boolean => {
    if (value === null) return false;
    if (isAdmin) return true;
    if (!BUILTINS.has(value)) {
      // Fail closed until the role row loads — a custom role shows only
      // what its statements grant, nothing more.
      const stmts = customRole.data?.permission;
      return stmts?.[resource]?.includes(action) === true;
    }
    return (
      betterAuthClient.organization.checkRolePermission({
        role: value,
        permissions: { [resource]: [action] },
      }) === true
    );
  };
  return {
    role: value,
    isAdmin,
    isGuest: value === "guest",
    can,
    isLoaded: role.isSuccess,
  };
}

import { usePermissions } from "@/hooks/use-permissions";
import { betterAuthClient } from "@/lib/better-auth";

/** Resource:action check against the active member's role — the
 * frontend half of the server's `rls("resource:action")`. Uses BA's
 * official checkRolePermission so custom roles work without a
 * client-side permission map. */
export function useCan(
  organizationId: string,
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
) {
  const permissions = usePermissions(organizationId);
  if (!permissions.isLoaded || permissions.role === null) return false;
  if (permissions.isAdmin) return true;
  const result = betterAuthClient.organization.checkRolePermission({
    role: permissions.role,
    permissions: { [resource]: [action] },
  });
  return result === true;
}

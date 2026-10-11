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
  const value = role.data ?? null;
  return {
    role: value,
    isAdmin: value === "owner" || value === "admin",
    isLoaded: role.isSuccess,
  };
}

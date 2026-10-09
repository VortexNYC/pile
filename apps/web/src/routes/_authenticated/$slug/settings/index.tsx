import { Text } from "@cloudflare/kumo/components/text";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  isOrganizationAdminRole,
  OrganizationProfile,
  SettingsStack,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/")({
  component: GeneralSettings,
});

function GeneralSettings() {
  const workspace = useWorkspace();
  const role = useQuery({
    queryKey: wsKey(workspace.id, "member-role"),
    queryFn: async () => {
      await betterAuthClient.organization.setActive({
        organizationId: workspace.id,
      });
      const result = await betterAuthClient.organization.getActiveMemberRole();
      return result.data?.role ?? null;
    },
  });
  const canManage = isOrganizationAdminRole(role.data ?? undefined);

  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page
        title="Workspace"
        description={`Name, URL, and logo for ${workspace.name}.`}
      >
        {canManage ? (
          <SettingsStack>
            <OrganizationProfile
              className="w-full max-w-none"
              organizationId={workspace.id}
            />
          </SettingsStack>
        ) : (
          <Text variant="secondary" size="sm">
            Only workspace admins can change these settings.
          </Text>
        )}
      </Page>
    </AuthProvider>
  );
}

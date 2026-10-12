import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  OrganizationProfile,
  SettingsStack,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { EmptyState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace } from "@/hooks/use-workspace";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/")({
  component: GeneralSettings,
});

function GeneralSettings() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);

  if (!permissions.isLoaded) {
    return <LoadingState label="Checking access" />;
  }

  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page
        title="Workspace"
        description={`Name, URL, and logo for ${workspace.name}.`}
      >
        {permissions.isAdmin ? (
          <SettingsStack>
            <OrganizationProfile
              className="w-full max-w-none"
              organizationId={workspace.id}
            />
          </SettingsStack>
        ) : (
          <EmptyState
            title="Admins only"
            description="Workspace settings are restricted to admins."
          />
        )}
      </Page>
    </AuthProvider>
  );
}

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  InviteMemberForm,
  isOrganizationAdminRole,
  OrganizationMembers,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/members")({
  component: MembersSettings,
});

function MembersSettings() {
  const workspace = useWorkspace();
  // better-auth-ui's member screens read and mutate the session's *active*
  // org, so they only mount after it is confirmed to be this workspace.
  const role = useQuery({
    queryKey: wsKey(workspace.id, "member-role"),
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      await betterAuthClient.organization.setActive({
        organizationId: workspace.id,
      });
      const result = await betterAuthClient.organization.getActiveMemberRole();
      return result.data?.role ?? null;
    },
  });
  const canManage = isOrganizationAdminRole(role.data ?? undefined);

  if (role.isPending) return <LoadingState label="Loading members" />;
  if (role.isError) {
    return (
      <Page title="Members">
        <ErrorState error={role.error} onRetry={() => void role.refetch()} />
      </Page>
    );
  }

  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page title="Members" description={`People in ${workspace.name}.`}>
        <div key={workspace.id} className="flex flex-col gap-5">
          {canManage ? (
            <InviteMemberForm
              className="w-full max-w-none"
              title="Invite a teammate"
              description="They'll get an email with a link to join."
            />
          ) : null}
          <OrganizationMembers
            className="w-full max-w-none"
            canManageMembers={canManage}
          />
        </div>
      </Page>
    </AuthProvider>
  );
}

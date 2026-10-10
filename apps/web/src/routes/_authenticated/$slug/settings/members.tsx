import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  InviteMemberForm,
  OrganizationMembers,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace } from "@/hooks/use-workspace";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/members")({
  component: MembersSettings,
});

function MembersSettings() {
  const workspace = useWorkspace();
  const canManage = usePermissions(workspace.id).isAdmin;

  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page title="Members" description={`People in ${workspace.name}.`}>
        <div className="flex flex-col gap-5">
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

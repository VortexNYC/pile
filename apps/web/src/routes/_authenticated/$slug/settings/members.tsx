import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  InviteMemberForm,
  OrganizationMembers,
} from "@vortex-api/better-auth-ui";

import { Page } from "@/components/page";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";

export const Route = createFileRoute("/_authenticated/$slug/settings/members")({
  component: MembersSettings,
});

function MembersSettings() {
  const workspace = useWorkspace();
  const canManage = usePermissions(workspace.id).isAdmin;
  // Builtin role names plus every custom role on the org.
  const customRoles = useQuery({
    queryKey: wsKey(workspace.id, "org-roles"),
    queryFn: async () => {
      const result = await betterAuthClient.$fetch(
        `/organization/list-roles?organizationId=${workspace.id}`
      );
      return (result.data ?? []) as { role: string }[];
    },
  });
  const roleOptions = [
    "member",
    "admin",
    "guest",
    ...(customRoles.data ?? []).map((r) => r.role),
  ];

  return (
    <AuthProvider client={getBetterAuthUiClient()}>
      <Page title="Members" description={`People in ${workspace.name}.`}>
        <div className="flex flex-col gap-5">
          {canManage ? (
            <InviteMemberForm
              className="w-full max-w-none"
              title="Invite a teammate"
              description="They'll get an email with a link to join."
              roleOptions={roleOptions}
            />
          ) : null}
          <OrganizationMembers
            className="w-full max-w-none"
            canManageMembers={canManage}
            roleOptions={roleOptions}
          />
        </div>
      </Page>
    </AuthProvider>
  );
}

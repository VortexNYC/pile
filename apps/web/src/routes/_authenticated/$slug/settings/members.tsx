import { Button } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AuthProvider,
  InviteMemberForm,
  OrganizationMembers,
} from "@vortex-api/better-auth-ui";
import { useState } from "react";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { getBetterAuthUiClient } from "@/lib/better-auth-ui-adapter";
import { toastError } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/settings/members")({
  component: MembersSettings,
});

function MembersSettings() {
  const workspace = useWorkspace();
  const canManage = usePermissions(workspace.id).isAdmin;
  // better-auth-ui's member screens act on the session's *active* org —
  // point it at this workspace before they mount, re-run per mount.
  const active = useQuery({
    queryKey: wsKey(workspace.id, "active-org"),
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      await betterAuthClient.organization.setActive({
        organizationId: workspace.id,
      });
      return true;
    },
  });
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

  if (active.isPending) return <LoadingState label="Loading members" />;
  if (active.isError) {
    return (
      <Page title="Members">
        <ErrorState
          error={active.error}
          onRetry={() => void active.refetch()}
        />
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
              roleOptions={roleOptions}
            />
          ) : null}
          <OrganizationMembers
            className="w-full max-w-none"
            membersLabel="Everyone with access"
            canManageMembers={canManage}
            roleOptions={roleOptions}
          />
          {canManage ? <ViewAs workspaceId={workspace.id} /> : null}
        </div>
      </Page>
    </AuthProvider>
  );
}

/** Admin "view as" — swap the session for a member's via BA's
 * impersonateUser; the banner in the shell offers the way back. */
function ViewAs({ workspaceId }: { workspaceId: string }) {
  const [userId, setUserId] = useState("");
  const members = useQuery({
    queryKey: wsKey(workspaceId, "impersonate-members"),
    queryFn: async () => {
      const result = await betterAuthClient.organization.listMembers({
        query: { organizationId: workspaceId },
      });
      return (result.data?.members ?? []) as {
        userId: string;
        user: { name?: string | null; email?: string | null };
      }[];
    },
  });
  const impersonate = useMutation({
    mutationFn: async () => {
      const result = await betterAuthClient.admin.impersonateUser({
        userId,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Impersonation failed");
      }
      window.location.href = "/app";
    },
    onError: (error) => toastError(error),
  });
  return (
    <div className="flex items-center gap-3">
      <Select
        value={userId}
        onValueChange={(v) => setUserId(v ?? "")}
        placeholder="View as member…"
      >
        {(members.data ?? []).map((m) => (
          <Select.Option key={m.userId} value={m.userId}>
            {m.user.name ?? m.user.email ?? m.userId}
          </Select.Option>
        ))}
      </Select>
      <Button
        variant="secondary"
        onClick={() => impersonate.mutate()}
        disabled={!userId || impersonate.isPending}
      >
        View as
      </Button>
    </div>
  );
}

import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { CreateDealDialog } from "@/components/create-deal-dialog";
import { CreateIssueDialog } from "@/components/create-issue-dialog";
import { CreateTicketDialog } from "@/components/create-ticket-dialog";
import { NotificationsBell } from "@/components/notifications-bell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspaces, WorkspaceContext } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

export const Route = createFileRoute("/_authenticated/$slug")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { slug } = Route.useParams();
  const workspaces = useWorkspaces();
  // Accept the org id too — CLI-side links (pile.nyc/app/<org>/...) carry
  // the organizationId, not the slug.
  const workspace =
    workspaces.data?.find((w) => w.slug === slug || w.id === slug) ?? null;
  const workspaceId = workspace?.id;

  // better-auth-ui's member screens act on the session's active org.
  useEffect(() => {
    if (workspaceId) {
      void betterAuthClient.organization.setActive({
        organizationId: workspaceId,
      });
    }
  }, [workspaceId]);

  if (workspaces.isPending) {
    return <LoadingState label="Loading workspace" />;
  }
  if (workspaces.isError) {
    return (
      <div className="p-10">
        <ErrorState
          error={workspaces.error}
          onRetry={() => void workspaces.refetch()}
        />
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="p-10">
        <EmptyState
          title="Workspace not found"
          description="It may not exist, or you're not a member of it."
        />
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={workspace}>
      <Sidebar.Provider className="bg-kumo-canvas h-dvh min-h-0">
        <CommandMenu />
        <CreateIssueDialog />
        <CreateTicketDialog />
        <CreateCustomerDialog />
        <CreateDealDialog />
        <AppSidebar workspace={workspace} workspaces={workspaces.data} />
        <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col">
          <header className="border-kumo-hairline flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
            <Sidebar.Trigger />
            <NotificationsBell />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <GuestGate workspace={workspace}>
              <Outlet key={workspace.id} />
            </GuestGate>
          </main>
        </div>
      </Sidebar.Provider>
    </WorkspaceContext.Provider>
  );
}

/** Guests are docs-only — any off-surface path routes to /documents. */
function GuestGate({
  workspace,
  children,
}: {
  workspace: { id: string; slug: string };
  children: React.ReactNode;
}) {
  const { pathname } = useLocation();
  const permissions = usePermissions(workspace.id);
  const navigate = useNavigate();

  useEffect(() => {
    if (!permissions.isGuest) return;
    const allowed =
      pathname.startsWith(`/${workspace.slug}/documents`) ||
      pathname.startsWith(`/${workspace.slug}/settings/account`);
    if (!allowed) {
      void navigate({ to: `/${workspace.slug}/documents` });
    }
  }, [pathname, permissions.isGuest, workspace.slug, navigate]);

  return <>{children}</>;
}

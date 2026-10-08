import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { NotificationsBell } from "@/components/notifications-bell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspaces, WorkspaceContext } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

export const Route = createFileRoute("/_authenticated/$slug")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { slug } = Route.useParams();
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.slug === slug) ?? null;
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
        <AppSidebar workspace={workspace} workspaces={workspaces.data} />
        <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col">
          <header className="border-kumo-hairline flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
            <Sidebar.Trigger />
            <NotificationsBell />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet key={workspace.id} />
          </main>
        </div>
      </Sidebar.Provider>
    </WorkspaceContext.Provider>
  );
}

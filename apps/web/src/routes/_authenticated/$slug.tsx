import { Button } from "@cloudflare/kumo/components/button";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { MagnifyingGlass, Newspaper } from "@phosphor-icons/react";
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
import { CreateInitiativeDialog } from "@/components/create-initiative-dialog";
import { CreateIssueDialog } from "@/components/create-issue-dialog";
import { CreateMenu } from "@/components/create-menu";
import { CreateRoadmapDialog } from "@/components/create-roadmap-dialog";
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
  const navigate = useNavigate();
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
        <CreateInitiativeDialog />
        <CreateRoadmapDialog />
        <AppSidebar workspace={workspace} workspaces={workspaces.data} />
        <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col">
          <header className="border-kumo-hairline flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <Sidebar.Trigger />
            <div className="flex min-w-0 flex-1 justify-center px-2">
              <button
                type="button"
                aria-label="Search"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("pile:command-menu"))
                }
                className="flex w-full max-w-md items-center gap-2 rounded-md border border-kumo-line px-3 py-1.5 text-left text-sm text-kumo-subtle hover:bg-kumo-tint"
              >
                <MagnifyingGlass size={16} />
                <span className="min-w-0 flex-1">Search…</span>
                <span className="text-[10px] font-mono">⌘K</span>
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <CreateMenu />
              <Button
                shape="square"
                variant="ghost"
                icon={<Newspaper size={18} />}
                aria-label="Changelog"
                onClick={() =>
                  void navigate({
                    to: "/$slug/changelog",
                    params: { slug: workspace.slug },
                  })
                }
              />
              <NotificationsBell />
            </div>
          </header>
          <ImpersonationBanner />
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

/** Redirect members to a surface they can view when they land on a
 * path their role excludes — mirrors the server's rls gates. */
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
    if (!permissions.isLoaded || permissions.role === null) return;
    if (permissions.isAdmin) return;
    // First surface the member can see — the redirect target.
    const home = permissions.can("document", "view")
      ? `/${workspace.slug}/documents`
      : `/${workspace.slug}`;
    const SURFACE_RESOURCES: Array<
      [string, Parameters<typeof permissions.can>[0]]
    > = [
      ["/issues", "issue"],
      ["/tickets", "ticket"],
      ["/documents", "document"],
      ["/customers", "customer"],
      ["/contacts", "contact"],
      ["/deals", "deal"],
      ["/projects", "project"],
      ["/sessions", "session"],
      ["/settings", "settings"],
    ];
    const rel = pathname.slice(`/${workspace.slug}`.length);
    const match = SURFACE_RESOURCES.find(([prefix]) => rel.startsWith(prefix));
    // Account settings are always allowed; other settings need the role.
    if (rel.startsWith("/settings/account")) return;
    // Scoped roles (custom account types) land on their accessible
    // surface — the overview reads surfaces they can't reach.
    if (rel === "" || rel === "/") {
      if (permissions.role !== "member" && home !== `/${workspace.slug}`) {
        void navigate({ to: home });
      }
      return;
    }
    if (match && !permissions.can(match[1], "view")) {
      void navigate({ to: home });
    }
  }, [pathname, permissions, workspace.slug, navigate]);

  return <>{children}</>;
}

/** Shown while an admin views as another member — BA's admin plugin marks
 * the session with `impersonatedBy`. One click returns to their own
 * session. */
function ImpersonationBanner() {
  const { data: session } = betterAuthClient.useSession();
  const impersonatedBy = (
    session?.session as { impersonatedBy?: string } | undefined
  )?.impersonatedBy;
  if (!impersonatedBy) return null;
  return (
    <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <div className="flex items-center justify-between gap-3">
        <span>
          Viewing as {session?.user?.email ?? "another member"} — actions count
          as theirs.
        </span>
        <Button
          variant="secondary"
          onClick={async () => {
            await betterAuthClient.admin.stopImpersonating();
            window.location.href = "/app";
          }}
        >
          Stop impersonating
        </Button>
      </div>
    </div>
  );
}

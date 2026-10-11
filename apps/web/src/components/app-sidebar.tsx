import {
  Sidebar,
  SidebarCollapsible,
  SidebarCollapsibleContent,
  SidebarCollapsibleTrigger,
} from "@cloudflare/kumo/components/sidebar";
import { Text } from "@cloudflare/kumo/components/text";
import {
  BellRinging,
  Buildings,
  FileText,
  Star,
  Flag,
  FolderOpen,
  Headset,
  House,
  ImageSquare,
  Key,
  Layout,
  ListChecks,
  MapTrifold,
  Megaphone,
  Robot,
  SignOut,
  Timer,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { InboxList } from "@/components/inbox-list";
import { PeekDrawer } from "@/components/peek-drawer";
import { useFavorites } from "@/hooks/use-favorites";
import { usePermissions } from "@/hooks/use-permissions";
import { useSurfaces } from "@/hooks/use-surfaces";
import { wsKey } from "@/hooks/use-workspace";
import type { Workspace } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import { appHref } from "@/lib/router-path";

const NAV = [
  { title: "Overview", path: "", icon: House, exact: true },
  { title: "Issues", path: "issues", icon: ListChecks },
  { title: "Support", path: "tickets", icon: Headset },
  { title: "Documents", path: "documents", icon: FileText },
  // opt-in surfaces — hidden unless enabled in settings
  { title: "Cycles", path: "cycles", icon: Timer },
  { title: "Initiatives", path: "initiatives", icon: Flag },
  { title: "Roadmaps", path: "roadmaps", icon: MapTrifold },
] as const;

const SETTINGS = [
  {
    title: "Workspace",
    path: "settings",
    icon: Buildings,
    exact: true,
    admin: true,
  },
  { title: "Members", path: "settings/members", icon: UsersThree },
  { title: "Surfaces", path: "settings/surfaces", icon: Layout },
  {
    title: "Developer",
    path: "settings/developer",
    icon: Key,
    admin: true,
  },
  { title: "Account", path: "settings/account", icon: UserCircle },
] as const;

export function AppSidebar({
  workspace,
  workspaces,
}: {
  workspace: Workspace;
  workspaces: readonly Workspace[];
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const surfaces = useSurfaces(workspace.id);
  const favs = useFavorites(workspace.id);
  const permissions = usePermissions(workspace.id);
  const [inboxOpen, setInboxOpen] = useState(false);
  const unread = useQuery({
    queryKey: wsKey(workspace.id, "notifications", "unread-count"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/notifications", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: "100" },
            },
          })
        )
      ).notifications.filter((n) => !n.read).length,
    refetchInterval: 30_000,
  });
  const base = `/${workspace.slug}`;
  const isActive = (path: string) =>
    pathname === `${base}/${path}` || pathname.startsWith(`${base}/${path}/`);
  const isOverviewActive = pathname === base || pathname === `${base}/`;

  return (
    <Sidebar aria-label="Workspace navigation">
      <Sidebar.Header className="px-3 py-3 flex items-center justify-between">
        <Text variant="heading" as="span" truncate>
          {workspace.name}
        </Text>
        <button
          type="button"
          aria-label="Inbox"
          onClick={() => setInboxOpen(true)}
          className="relative rounded-md p-1.5 text-kumo-subtle hover:bg-kumo-tint"
        >
          <BellRinging size={18} />
          {(unread.data ?? 0) > 0 ? (
            <span className="bg-kumo-brand text-kumo-contrast absolute -right-0.5 -top-0.5 rounded-full px-1 text-[10px] font-medium">
              {unread.data}
            </span>
          ) : null}
        </button>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            {NAV.filter((item) => !surfaces.hidden.has(item.path)).map(
              (item) => (
                <Sidebar.MenuButton
                  key={item.path}
                  icon={item.icon}
                  active={
                    "exact" in item && item.exact
                      ? isOverviewActive
                      : isActive(item.path)
                  }
                  href={appHref(`${base}/${item.path}`)}
                  tooltip={item.title}
                >
                  {item.title}
                </Sidebar.MenuButton>
              )
            )}
          </Sidebar.Menu>
        </Sidebar.Group>
        {favs.favorites.length > 0 ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>Starred</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {favs.favorites.map((f) => (
                <Sidebar.MenuButton
                  key={`${f.type}:${f.id}`}
                  icon={f.type === "document" ? FileText : Star}
                  href={appHref(
                    `${base}/${f.type === "document" ? "documents" : "issues"}/${f.id}`
                  )}
                  tooltip={f.title}
                >
                  {f.identifier ? `${f.identifier} — ` : ""}
                  {f.title}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        ) : null}
        <Sidebar.Group>
          <Sidebar.GroupLabel>Settings</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {SETTINGS.filter(
              (item) => !("admin" in item && item.admin) || permissions.isAdmin
            ).map((item) => (
              <Sidebar.MenuButton
                key={item.path}
                icon={item.icon}
                active={
                  "exact" in item && item.exact
                    ? pathname === `${base}/${item.path}` ||
                      pathname === `${base}/${item.path}/`
                    : isActive(item.path)
                }
                href={appHref(`${base}/${item.path}`)}
                tooltip={item.title}
              >
                {item.title}
              </Sidebar.MenuButton>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        {workspaces.length > 1 ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>Workspaces</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {workspaces.map((w) => (
                <Sidebar.MenuButton
                  key={w.id}
                  active={w.id === workspace.id}
                  href={appHref(`/${w.slug}/issues`)}
                >
                  {w.name}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        ) : null}
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Menu>
          <Sidebar.MenuButton
            icon={SignOut}
            onClick={async () => {
              await betterAuthClient.signOut();
              queryClient.clear();
              await navigate({ to: "/sign-in" });
            }}
          >
            Sign out
          </Sidebar.MenuButton>
        </Sidebar.Menu>
      </Sidebar.Footer>
      <PeekDrawer open={inboxOpen} onOpenChange={setInboxOpen}>
        <div className="mb-2 text-lg font-semibold text-kumo-default">
          Inbox
        </div>
        <InboxList
          organizationId={workspace.id}
          slug={workspace.slug}
          onNavigate={() => setInboxOpen(false)}
        />
      </PeekDrawer>
    </Sidebar>
  );
}

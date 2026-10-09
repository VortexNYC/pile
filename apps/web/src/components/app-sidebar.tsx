import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Text } from "@cloudflare/kumo/components/text";
import {
  Buildings,
  FileText,
  Flag,
  FolderOpen,
  Headset,
  House,
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
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useSurfaces } from "@/hooks/use-surfaces";
import type { Workspace } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { appHref } from "@/lib/router-path";

const NAV = [
  { title: "Overview", path: "", icon: House, exact: true },
  { title: "Issues", path: "issues", icon: ListChecks },
  { title: "Sessions", path: "sessions", icon: Robot },
  { title: "Projects", path: "projects", icon: FolderOpen },
  { title: "Documents", path: "documents", icon: FileText },
  { title: "Support", path: "tickets", icon: Headset },
  { title: "Customers", path: "customers", icon: Buildings },
  { title: "Changelog", path: "changelog", icon: Megaphone },
  { title: "Cycles", path: "cycles", icon: Timer },
  { title: "Initiatives", path: "initiatives", icon: Flag },
  { title: "Roadmaps", path: "roadmaps", icon: MapTrifold },
] as const;

const SETTINGS = [
  { title: "Workspace", path: "settings", icon: Buildings, exact: true },
  { title: "Members", path: "settings/members", icon: UsersThree },
  { title: "Surfaces", path: "settings/surfaces", icon: Layout },
  { title: "Developer", path: "settings/developer", icon: Key },
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
  const base = `/${workspace.slug}`;
  const isActive = (path: string) =>
    pathname === `${base}/${path}` || pathname.startsWith(`${base}/${path}/`);
  const isOverviewActive = pathname === base || pathname === `${base}/`;

  return (
    <Sidebar aria-label="Workspace navigation">
      <Sidebar.Header className="px-3 py-3">
        <Text variant="heading" as="span" truncate>
          {workspace.name}
        </Text>
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
        <Sidebar.Group>
          <Sidebar.GroupLabel>Settings</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {SETTINGS.map((item) => (
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
    </Sidebar>
  );
}

import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Text } from "@cloudflare/kumo/components/text";
import {
  Buildings,
  FileText,
  Headset,
  Key,
  ListChecks,
  SignOut,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";

import type { Workspace } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { appHref } from "@/lib/router-path";

const NAV = [
  { title: "Issues", path: "issues", icon: ListChecks },
  { title: "Documents", path: "documents", icon: FileText },
  { title: "Support", path: "tickets", icon: Headset },
  { title: "Customers", path: "customers", icon: Buildings },
] as const;

const SETTINGS = [
  { title: "Workspace", path: "settings", icon: Buildings, exact: true },
  { title: "Members", path: "settings/members", icon: UsersThree },
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
  const base = `/${workspace.slug}`;
  const isActive = (path: string) =>
    pathname === `${base}/${path}` || pathname.startsWith(`${base}/${path}/`);

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
            {NAV.map((item) => (
              <Sidebar.MenuButton
                key={item.path}
                icon={item.icon}
                active={isActive(item.path)}
                href={appHref(`${base}/${item.path}`)}
                tooltip={item.title}
              >
                {item.title}
              </Sidebar.MenuButton>
            ))}
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

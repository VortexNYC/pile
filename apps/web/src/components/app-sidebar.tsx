import {
  Sidebar,
  SidebarCollapsible,
  SidebarCollapsibleContent,
  SidebarCollapsibleTrigger,
} from "@cloudflare/kumo/components/sidebar";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

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
  const permissions = usePermissions(workspace.id);
  const documents = useQuery({
    queryKey: wsKey(workspace.id, "documents"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).documents,
  });
  const docTree = useMemo(() => {
    const docs = documents.data ?? [];
    const children = new Map<string | null, typeof docs>();
    for (const doc of docs) {
      const key = doc.parentDocumentId ?? null;
      children.set(key, [...(children.get(key) ?? []), doc]);
    }
    return children;
  }, [documents.data]);
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
        {(docTree.get(null)?.length ?? 0) > 0 ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>Documents</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {(docTree.get(null) ?? []).slice(0, 20).map((doc) => {
                const kids = docTree.get(doc.id) ?? [];
                const href = appHref(`${base}/documents/${doc.id}`);
                if (kids.length === 0) {
                  return (
                    <Sidebar.MenuButton
                      key={doc.id}
                      icon={FileText}
                      active={isActive(`documents/${doc.id}`)}
                      href={href}
                      tooltip={doc.title}
                    >
                      {doc.icon ? `${doc.icon} ` : ""}
                      {doc.title}
                    </Sidebar.MenuButton>
                  );
                }
                return (
                  <SidebarCollapsible key={doc.id}>
                    <SidebarCollapsibleTrigger
                      render={
                        <Sidebar.MenuButton
                          icon={FileText}
                          active={isActive(`documents/${doc.id}`)}
                          href={href}
                          tooltip={doc.title}
                        >
                          {doc.icon ? `${doc.icon} ` : ""}
                          {doc.title}
                          <Sidebar.MenuChevron />
                        </Sidebar.MenuButton>
                      }
                    />
                    <SidebarCollapsibleContent>
                      <Sidebar.MenuSub>
                        {kids.map((kid) => (
                          <Sidebar.MenuSubItem key={kid.id}>
                            <Sidebar.MenuSubButton
                              href={appHref(`${base}/documents/${kid.id}`)}
                            >
                              {kid.icon ? `${kid.icon} ` : ""}
                              {kid.title}
                            </Sidebar.MenuSubButton>
                          </Sidebar.MenuSubItem>
                        ))}
                      </Sidebar.MenuSub>
                    </SidebarCollapsibleContent>
                  </SidebarCollapsible>
                );
              })}
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
    </Sidebar>
  );
}

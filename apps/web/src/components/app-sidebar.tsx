import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Text } from "@cloudflare/kumo/components/text";
import {
  CaretUpDown,
  Folder,
  Robot,
  TrendUp,
  GearSix,
  Buildings,
  FileText,
  Star,
  Headset,
  House,
  Key,
  Layout,
  ListChecks,
  SignOut,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useFavorites } from "@/hooks/use-favorites";
import { usePermissions } from "@/hooks/use-permissions";
import { useSurfaces } from "@/hooks/use-surfaces";
import type { Workspace } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { appHref } from "@/lib/router-path";

// Nav items carry the resource they surface — the permission check
// hides any surface the member's role can't view.
const NAV = [
  { title: "Overview", path: "", icon: House, exact: true },
  { title: "Issues", path: "issues", icon: ListChecks, resource: "issue" },
  {
    title: "Documents",
    path: "documents",
    icon: FileText,
    resource: "document",
  },
  { title: "Sessions", path: "sessions", icon: Robot, resource: "session" },
  { title: "Projects", path: "projects", icon: Folder, resource: "project" },
  { title: "Support", path: "tickets", icon: Headset, resource: "ticket" },
  { title: "Sales", path: "sales", icon: TrendUp },
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
  {
    title: "Roles",
    path: "settings/roles",
    icon: UsersThree,
    admin: true,
  },
  { title: "Surfaces", path: "settings/surfaces", icon: Layout },
  { title: "Fields", path: "settings/fields", icon: Layout },
  {
    title: "Developer",
    path: "settings/developer",
    icon: Key,
    admin: true,
  },
  {
    title: "Agents",
    path: "settings/agents",
    icon: Robot,
    admin: true,
  },
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
  const { data: session } = betterAuthClient.useSession();
  const base = `/${workspace.slug}`;
  const isActive = (path: string) =>
    pathname === `${base}/${path}` || pathname.startsWith(`${base}/${path}/`);
  const isOverviewActive = pathname === base || pathname === `${base}/`;
  const isGuest = permissions.isGuest;
  const nav = isGuest ? NAV.filter((item) => item.path === "documents") : NAV;
  const user = session?.user;

  const signOut = async () => {
    await betterAuthClient.signOut();
    queryClient.clear();
    await navigate({ to: "/sign-in" });
  };

  return (
    <Sidebar aria-label="Workspace navigation">
      <Sidebar.Header className="px-3 py-3">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-kumo-tint"
              >
                <span className="bg-kumo-brand text-kumo-contrast flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <Text variant="heading" as="span" truncate>
                  {workspace.name}
                </Text>
                <CaretUpDown className="shrink-0 text-kumo-subtle" size={14} />
              </button>
            }
          />
          <DropdownMenu.Content className="min-w-48">
            {workspaces.map((w) => (
              <DropdownMenu.Item
                key={w.id}
                onClick={() =>
                  void navigate({
                    to: "/$slug/issues",
                    params: { slug: w.slug },
                  })
                }
              >
                {w.name}
                {w.id === workspace.id ? " ✓" : ""}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={<GearSix />}
              onClick={() =>
                void navigate({
                  to: "/$slug/settings",
                  params: { slug: workspace.slug },
                })
              }
            >
              Workspace settings
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            {nav
              .filter((item) => !surfaces.hidden.has(item.path))
              .filter(
                (item) =>
                  !("resource" in item) ||
                  permissions.can(item.resource as never, "view")
              )
              .map((item) => (
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
              ))}
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
        {permissions.can("settings", "view") ? (
          <Sidebar.Group>
            <Sidebar.GroupLabel>Settings</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {SETTINGS.filter(
                (item) =>
                  !("admin" in item && item.admin) || permissions.isAdmin
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
        ) : null}
      </Sidebar.Content>
      <Sidebar.Footer className="px-2 py-2">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                aria-label="Account"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-kumo-tint"
              >
                {user?.image ? (
                  <img
                    src={user.image}
                    alt=""
                    className="size-7 shrink-0 rounded-full"
                  />
                ) : (
                  <span className="bg-kumo-brand text-kumo-contrast flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                    {(user?.name ?? user?.email ?? "?")
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <Text as="span" size="sm" truncate>
                    {user?.name ?? "Account"}
                  </Text>
                  {user?.email ? (
                    <Text variant="secondary" as="span" size="xs" truncate>
                      {user.email}
                    </Text>
                  ) : null}
                </span>
                <CaretUpDown className="shrink-0 text-kumo-subtle" size={14} />
              </button>
            }
          />
          <DropdownMenu.Content side="top" align="start" className="min-w-56">
            <DropdownMenu.Item
              icon={<UserCircle />}
              onClick={() =>
                void navigate({
                  to: "/$slug/settings/account",
                  params: { slug: workspace.slug },
                })
              }
            >
              Account settings
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon={<SignOut />} onClick={signOut}>
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </Sidebar.Footer>
    </Sidebar>
  );
}

import { CommandPalette } from "@cloudflare/kumo/components/command-palette";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

interface IssueSummary {
  id: string;
  title: string;
  identifier: string | null;
  status: string;
}

interface CommandItem {
  key: string;
  label: string;
  hint?: string;
  // Typed destination — `to` + params for the router, or `href` for
  // same-origin paths outside the typed tree.
  href: string;
}

/** ⌘K jump-bar — Linear's command palette. Searches open issues and
 * jumps to any surface in the workspace. */
export function CommandMenu() {
  const workspace = useWorkspace();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const issues = useQuery({
    queryKey: wsKey(workspace.id, "issues", { search: query }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 8, search: query || undefined },
            },
          })
        )
      ).issues,
    enabled: open,
    placeholderData: keepPreviousData,
  });

  const staticItems: CommandItem[] = useMemo(
    () => [
      { key: "nav-issues", label: "Go to Issues", href: "/issues" },
      { key: "nav-projects", label: "Go to Projects", href: "/projects" },
      { key: "nav-sessions", label: "Go to Sessions", href: "/sessions" },
      { key: "nav-docs", label: "Go to Documents", href: "/documents" },
      { key: "nav-support", label: "Go to Support", href: "/tickets" },
      {
        key: "nav-changelog",
        label: "Go to Changelog",
        href: "/changelog",
      },
      { key: "nav-new", label: "Create issue", href: "/issues/new" },
    ],
    []
  );

  const items: CommandItem[] = useMemo(() => {
    const issueItems = (issues.data ?? []).map((issue: IssueSummary) => ({
      key: `issue-${issue.id}`,
      label: issue.title,
      hint: issue.identifier ?? issue.status,
      href: `/issues/${issue.identifier ?? issue.id}`,
    }));
    const filtered = query
      ? staticItems.filter((item) =>
          item.label.toLowerCase().includes(query.toLowerCase())
        )
      : staticItems;
    return [...issueItems, ...filtered];
  }, [issues.data, query, staticItems]);

  const go = (item: CommandItem) => {
    window.location.assign(`/app/${workspace.slug}${item.href}`);
    setOpen(false);
  };

  return (
    <CommandPalette.Root
      open={open}
      onOpenChange={setOpen}
      items={items}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(item) => item.label}
      onSelect={(item) => go(item)}
    >
      <CommandPalette.Input placeholder="Jump to an issue or surface…" />
      <CommandPalette.List>
        {items.map((item) => (
          <CommandPalette.Item
            key={item.key}
            value={item}
            onClick={() => go(item)}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint ? (
              <span className="text-xs text-kumo-subtle">{item.hint}</span>
            ) : null}
          </CommandPalette.Item>
        ))}
      </CommandPalette.List>
      <CommandPalette.Footer />
    </CommandPalette.Root>
  );
}

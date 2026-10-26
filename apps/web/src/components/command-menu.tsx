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
/** PILE-645 — heavy palette feeds (documents, customers) only fetch once
 * the operator has typed a search term. */
export function paletteDeepQueryEnabled(open: boolean, query: string) {
  return open && query.trim().length > 0;
}

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
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pile:command-menu", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pile:command-menu", onOpen);
    };
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
    staleTime: 60_000,
  });
  const documents = useQuery({
    queryKey: wsKey(workspace.id, "palette-documents", { search: query }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: {
              path: { organizationId: workspace.id },
              query: { summary: "1" },
            },
          })
        )
      ).documents,
    enabled: paletteDeepQueryEnabled(open, query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const tickets = useQuery({
    queryKey: wsKey(workspace.id, "palette-tickets", { search: query }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 6, q: query || undefined },
            },
          })
        )
      ).tickets,
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const customers = useQuery({
    queryKey: wsKey(workspace.id, "palette-customers", { search: query }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
    enabled: paletteDeepQueryEnabled(open, query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const staticItems: CommandItem[] = useMemo(
    () => [
      { key: "nav-issues", label: "Go to Issues", href: "/issues" },
      { key: "nav-projects", label: "Go to Projects", href: "/projects" },
      { key: "nav-sessions", label: "Go to Sessions", href: "/sessions" },
      { key: "nav-docs", label: "Go to Documents", href: "/documents" },
      { key: "nav-support", label: "Go to Support", href: "/tickets" },
      { key: "nav-sales", label: "Go to Sales", href: "/sales" },
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
    const docItems = (documents.data ?? [])
      .filter(
        (d) => !query || d.title.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 6)
      .map((d) => ({
        key: `doc-${d.id}`,
        label: d.title,
        hint: "document",
        href: `/documents/${d.id}`,
      }));
    const ticketItems = (tickets.data ?? []).map((tk) => ({
      key: `ticket-${tk.id}`,
      label: `#${tk.number} ${tk.title}`,
      hint: tk.status,
      href: `/tickets/${tk.id}`,
    }));
    const customerItems = (customers.data ?? [])
      .filter(
        (c) => !query || c.name.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 6)
      .map((c) => ({
        key: `customer-${c.id}`,
        label: c.name,
        hint: "company",
        href: `/customers/${c.id}`,
      }));
    const filtered = query
      ? staticItems.filter((item) =>
          item.label.toLowerCase().includes(query.toLowerCase())
        )
      : staticItems;
    return [
      ...issueItems,
      ...docItems,
      ...ticketItems,
      ...customerItems,
      ...filtered,
    ];
  }, [
    issues.data,
    documents.data,
    tickets.data,
    customers.data,
    query,
    staticItems,
  ]);

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

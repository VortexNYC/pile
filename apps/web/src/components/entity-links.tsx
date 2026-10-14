import { Button } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import {
  Buildings,
  FileText,
  Folder,
  Headset,
  LinkSimple,
  ListChecks,
  Robot,
  TrendUp,
  User,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { RailSection } from "@/components/entity-page";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError } from "@/lib/toast";

/** The graph — every node's rail shows its edges, both directions.
 * This is the product: entities are nodes, links are the story. */

const ROUTES: Record<string, (slug: string, id: string) => string> = {
  issue: (slug, id) => `/${slug}/issues/${id}`,
  ticket: (slug, id) => `/${slug}/tickets/${id}`,
  deal: (slug, id) => `/${slug}/deals/${id}`,
  customer: (slug, id) => `/${slug}/customers/${id}`,
  contact: (slug, id) => `/${slug}/contacts/${id}`,
  document: (slug, id) => `/${slug}/documents/${id}`,
  session: (slug, id) => `/${slug}/sessions/${id}`,
  project: (slug, id) => `/${slug}/projects/${id}`,
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  issue: <ListChecks size={14} />,
  ticket: <Headset size={14} />,
  deal: <TrendUp size={14} />,
  customer: <Buildings size={14} />,
  contact: <User size={14} />,
  document: <FileText size={14} />,
  session: <Robot size={14} />,
  project: <Folder size={14} />,
};

type EntityOption = { id: string; label: string };

/** Title-search per entity type — hits the existing list endpoints. */
function useEntitySearch(toType: string, q: string) {
  const workspace = useWorkspace();
  return useQuery({
    queryKey: wsKey(workspace.id, "entity-search", toType, q),
    queryFn: async (): Promise<EntityOption[]> => {
      const org = workspace.id;
      if (toType === "issue") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: org },
              query: { search: q || undefined, limit: 8 },
            },
          })
        );
        return data.issues.map((i) => ({
          id: i.id,
          label: `${i.identifier ?? ""} ${i.title}`.trim(),
        }));
      }
      if (toType === "ticket") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: { path: { organizationId: org }, query: { q, limit: 8 } },
          })
        );
        return data.tickets.map((t) => ({ id: t.id, label: t.title }));
      }
      if (toType === "deal") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/deals", {
            params: { path: { organizationId: org } },
          })
        );
        return data.deals
          .filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((d) => ({ id: d.id, label: d.name }));
      }
      if (toType === "customer") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: org } },
          })
        );
        return data.customers
          .filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((x) => ({ id: x.id, label: x.name }));
      }
      if (toType === "contact") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/support/customers", {
            params: { path: { organizationId: org }, query: { q, limit: 8 } },
          })
        );
        return data.customers.map((x) => ({
          id: x.id,
          label: x.fullName ?? x.email,
        }));
      }
      if (toType === "document") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: { path: { organizationId: org }, query: {} },
          })
        );
        return data.documents
          .filter((d) => !q || d.title.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((d) => ({
            id: d.id,
            label: d.title || "Untitled",
          }));
      }
      if (toType === "session") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/agent/sessions", {
            params: { path: { organizationId: org } },
          })
        );
        return data.sessions
          .filter((s) => !q || (s.label ?? "").toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((s) => ({ id: s.id, label: s.label ?? s.id.slice(0, 8) }));
      }
      if (toType === "project") {
        const data = await unwrap(
          api.GET("/workspaces/{organizationId}/projects", {
            params: { path: { organizationId: org } },
          })
        );
        return data.projects
          .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((p) => ({ id: p.id, label: p.name }));
      }
      return [];
    },
    staleTime: 15_000,
  });
}

export function EntityLinksRail({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [toType, setToType] = useState("issue");
  const [toId, setToId] = useState("");
  const [toLabel, setToLabel] = useState("");
  const [q, setQ] = useState("");
  const options = useEntitySearch(toType, q);
  const key = wsKey(workspace.id, "links", entityType, entityId);

  const links = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/entities/{entityType}/{entityId}/links",
            {
              params: {
                path: { organizationId: workspace.id, entityType, entityId },
              },
            }
          )
        )
      ).links,
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST(
          "/workspaces/{organizationId}/entities/{entityType}/{entityId}/links",
          {
            params: {
              path: { organizationId: workspace.id, entityType, entityId },
            },
            body: { toType, toId: toId.trim(), kind: "relates" },
          }
        )
      ),
    onSuccess: () => {
      setToId("");
      setAdding(false);
    },
    onError: (error) => toastError(error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: (linkId: string) =>
      unwrap(
        api.DELETE("/workspaces/{organizationId}/links/{linkId}", {
          params: { path: { organizationId: workspace.id, linkId } },
        })
      ),
    onError: (error) => toastError(error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const items = links.data ?? [];
  const navigate = useNavigate();

  return (
    <RailSection title="Linked">
      <div className="flex flex-col gap-1.5">
        {items.map((link) => {
          const other =
            link.fromType === entityType && link.fromId === entityId
              ? { type: link.toType, id: link.toId }
              : { type: link.fromType, id: link.fromId };
          const href = ROUTES[other.type]?.(workspace.slug, other.id);
          const text = link.label ?? `${other.type} ${other.id.slice(0, 8)}`;
          return (
            <div key={link.id} className="flex items-center gap-2">
              <span className="text-kumo-subtle">
                {TYPE_ICONS[other.type] ?? <LinkSimple size={14} />}
              </span>
              {href ? (
                <button
                  type="button"
                  onClick={() => void navigate({ to: href })}
                  className="min-w-0 flex-1 truncate text-left text-sm text-kumo-link hover:underline"
                >
                  {text}
                </button>
              ) : (
                <span className="text-sm text-kumo-subtle">{text}</span>
              )}
              <button
                type="button"
                aria-label="Unlink"
                onClick={() => remove.mutate(link.id)}
                className="text-kumo-subtle hover:text-kumo-default"
              >
                ×
              </button>
            </div>
          );
        })}
        {adding ? (
          <div className="flex flex-col gap-2 border-t border-kumo-line pt-2">
            <Select
              aria-label="Entity type"
              value={toType}
              onValueChange={(v) => v && setToType(v)}
            >
              <Select.Option value="issue">Issue</Select.Option>
              <Select.Option value="ticket">Ticket</Select.Option>
              <Select.Option value="deal">Deal</Select.Option>
              <Select.Option value="customer">Company</Select.Option>
              <Select.Option value="contact">Contact</Select.Option>
              <Select.Option value="document">Document</Select.Option>
              <Select.Option value="session">Session</Select.Option>
              <Select.Option value="project">Project</Select.Option>
            </Select>
            <input
              aria-label="Search"
              placeholder="Search by title…"
              value={toLabel || q}
              onChange={(e) => {
                setToId("");
                setToLabel("");
                setQ(e.target.value);
              }}
              className="border-kumo-line bg-kumo-canvas h-8 rounded-md border px-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
            />
            {!toId && (options.data ?? []).length > 0 ? (
              <div className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-kumo-line">
                {(options.data ?? []).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setToId(o.id);
                      setToLabel(o.label);
                    }}
                    className="px-2 py-1.5 text-left text-sm text-kumo-default hover:bg-kumo-elevated"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => create.mutate()}
                loading={create.isPending}
                disabled={!toId.trim()}
              >
                Link
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            Link to…
          </Button>
        )}
      </div>
    </RailSection>
  );
}

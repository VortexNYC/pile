import { Button } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import {
  Buildings,
  FileText,
  Headset,
  LinkSimple,
  ListChecks,
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
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  issue: <ListChecks size={14} />,
  ticket: <Headset size={14} />,
  deal: <TrendUp size={14} />,
  customer: <Buildings size={14} />,
  contact: <User size={14} />,
  document: <FileText size={14} />,
};

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
                  {other.type} {other.id.slice(0, 8)}
                </button>
              ) : (
                <span className="text-sm text-kumo-subtle">
                  {other.type} {other.id.slice(0, 8)}
                </span>
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
              <Select.Option value="customer">Customer</Select.Option>
              <Select.Option value="contact">Contact</Select.Option>
              <Select.Option value="document">Document</Select.Option>
              <Select.Option value="session">Session</Select.Option>
            </Select>
            <input
              aria-label="Entity ID"
              placeholder="Entity id…"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              className="border-kumo-line bg-kumo-canvas h-8 rounded-md border px-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
            />
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

import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Image as ImageIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Media gallery across all tickets — reused by the captures route
 * and the Support tab. */
export function CapturesGrid() {
  const workspace = useWorkspace();
  const captures = useQuery({
    queryKey: wsKey(workspace.id, "captures"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/captures", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).captures,
  });

  if (captures.isPending) return <LoadingState label="Loading captures" />;
  if (captures.isError) {
    return (
      <ErrorState
        error={captures.error}
        onRetry={() => void captures.refetch()}
      />
    );
  }

  const rows = captures.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon size={40} />}
        title="No captures"
        description="Screenshots, videos, and logs from capture links land here."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {rows.map((capture) => (
        <Link
          key={capture.id}
          to="/$slug/tickets/$ticketId"
          params={{ slug: workspace.slug, ticketId: capture.ticket.id }}
          className="group block"
        >
          <LayerCard className="overflow-hidden p-0 transition-shadow group-hover:shadow-md">
            <div className="bg-kumo-tint flex aspect-video items-center justify-center overflow-hidden">
              {capture.type === "screenshot" &&
              capture.contentType?.startsWith("image/") &&
              capture.url ? (
                <img
                  src={capture.url}
                  alt={capture.fileName ?? "Capture"}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <ImageIcon size={28} className="text-kumo-subtle" />
              )}
            </div>
            <div className="flex flex-col gap-1 p-3">
              <div className="flex items-center gap-2">
                <Badge variant="neutral">{capture.type}</Badge>
                <span className="truncate text-xs text-kumo-subtle">
                  {capture.fileName ?? "artifact"}
                  {capture.size ? ` · ${formatSize(capture.size)}` : ""}
                </span>
              </div>
              <div className="truncate text-sm text-kumo-default">
                #{capture.ticket.number} {capture.ticket.title}
              </div>
              <div className="text-xs text-kumo-subtle">
                {formatRelative(capture.createdAt)}
              </div>
            </div>
          </LayerCard>
        </Link>
      ))}
    </div>
  );
}

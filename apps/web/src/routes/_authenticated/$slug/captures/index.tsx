import { Badge } from "@cloudflare/kumo/components/badge";
import { ImageSquare } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/captures/")({
  component: CapturesGallery,
});

function CapturesGallery() {
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
      <Page title="Captures">
        <ErrorState
          error={captures.error}
          onRetry={() => void captures.refetch()}
        />
      </Page>
    );
  }
  const items = captures.data ?? [];

  return (
    <Page
      title="Captures"
      description="Every screenshot, video, and log across support tickets."
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<ImageSquare size={40} />}
          title="No captures yet"
          description="Jam-style captures from support tickets land here."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => {
            const isImage = item.type === "screenshot";
            const isVideo = item.type === "video";
            return (
              <Link
                key={item.id}
                to="/$slug/tickets/$ticketId"
                params={{ slug: workspace.slug, ticketId: item.ticket.id }}
                className="group flex flex-col gap-2"
              >
                <div className="border-kumo-line aspect-video overflow-hidden rounded-lg border bg-kumo-tint flex items-center justify-center">
                  {isImage && item.url ? (
                    <img
                      src={item.url}
                      alt={item.fileName ?? item.ticket.title}
                      className="size-full object-cover"
                    />
                  ) : isVideo && item.url ? (
                    <video
                      src={item.url}
                      muted
                      playsInline
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-kumo-subtle">
                      <ImageSquare size={28} />
                      <span className="text-xs">{item.type}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 px-0.5">
                  <Badge variant="secondary">{item.type}</Badge>
                  <span className="min-w-0 flex-1 truncate text-xs text-kumo-default">
                    #{item.ticket.number} {item.ticket.title}
                  </span>
                  <span className="text-xs text-kumo-subtle shrink-0">
                    {formatRelative(item.createdAt)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}

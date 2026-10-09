import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/changelog/")({
  component: Changelog,
});

function Changelog() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;

  const entries = useQuery({
    queryKey: wsKey(organizationId, "changelog"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/changelog", {
            params: { path: { organizationId } },
          })
        )
      ).entries,
  });

  if (entries.isPending) return <LoadingState label="Loading changelog" />;
  if (entries.isError) {
    return (
      <Page title="Changelog">
        <ErrorState
          error={entries.error}
          onRetry={() => void entries.refetch()}
        />
      </Page>
    );
  }

  const rows = entries.data ?? [];

  return (
    <Page title="Changelog" description="What shipped recently.">
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing shipped yet"
          description="Entries appear here when published."
        />
      ) : (
        rows.map((entry) => (
          <LayerCard key={entry.id}>
            <LayerCard.Primary className="flex flex-col gap-3 p-6">
              <div className="flex items-baseline gap-3">
                <Text bold>{entry.title}</Text>
                <Text variant="secondary" size="sm">
                  {formatRelative(entry.updatedAt)}
                </Text>
              </div>
              {entry.body ? (
                <Markdown workspaceSlug={workspace.slug} content={entry.body} />
              ) : null}
            </LayerCard.Primary>
          </LayerCard>
        ))
      )}
    </Page>
  );
}

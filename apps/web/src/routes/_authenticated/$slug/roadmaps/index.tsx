import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/roadmaps/")({
  component: Roadmaps,
});

function Roadmaps() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;

  const roadmaps = useQuery({
    queryKey: wsKey(organizationId, "roadmaps"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/roadmaps", {
            params: { path: { organizationId } },
          })
        )
      ).roadmaps,
  });

  if (roadmaps.isPending) return <LoadingState label="Loading roadmaps" />;
  if (roadmaps.isError) {
    return (
      <Page title="Roadmaps">
        <ErrorState
          error={roadmaps.error}
          onRetry={() => void roadmaps.refetch()}
        />
      </Page>
    );
  }

  const rows = roadmaps.data ?? [];

  return (
    <Page
      title="Roadmaps"
      description="Long-range plans and their initiatives."
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No roadmaps"
          description="Roadmaps collect initiatives into a plan."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Roadmaps">
            <Table.Header>
              <Table.Row>
                <Table.Head>Roadmap</Table.Head>
                <Table.Head>Description</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.id}>
                  <Table.Cell>{r.name}</Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {r.description ?? "—"}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {formatRelative(r.updatedAt)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

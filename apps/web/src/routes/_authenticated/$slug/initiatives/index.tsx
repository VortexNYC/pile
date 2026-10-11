import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/initiatives/")({
  component: Initiatives,
});

function Initiatives() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;

  const initiatives = useQuery({
    queryKey: wsKey(organizationId, "initiatives"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/initiatives", {
            params: { path: { organizationId } },
          })
        )
      ).initiatives,
  });

  if (initiatives.isPending)
    return <LoadingState label="Loading initiatives" />;
  if (initiatives.isError) {
    return (
      <Page title="Initiatives">
        <ErrorState
          error={initiatives.error}
          onRetry={() => void initiatives.refetch()}
        />
      </Page>
    );
  }

  const rows = initiatives.data ?? [];

  return (
    <Page title="Initiatives" description="Cross-project bets and themes.">
      {rows.length === 0 ? (
        <EmptyState
          title="No initiatives"
          description="Initiatives group related projects under a theme."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Initiatives">
            <Table.Header>
              <Table.Row>
                <Table.Head>Initiative</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Target</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((item) => (
                <Table.Row key={item.id}>
                  <Table.Cell>{item.name}</Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {item.status}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {item.targetDate?.slice(0, 10) ?? "—"}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {formatRelative(item.updatedAt)}
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

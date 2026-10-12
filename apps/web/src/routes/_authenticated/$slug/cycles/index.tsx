import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/cycles/")({
  component: Cycles,
});

function Cycles() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;

  const cycles = useQuery({
    queryKey: wsKey(organizationId, "cycles"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/cycles", {
            params: { path: { organizationId } },
          })
        )
      ).cycles,
  });

  if (cycles.isPending) return <LoadingState label="Loading cycles" />;
  if (cycles.isError) {
    return (
      <Page title="Cycles">
        <ErrorState
          error={cycles.error}
          onRetry={() => void cycles.refetch()}
        />
      </Page>
    );
  }

  const rows = (cycles.data ?? []).filter((c) => !c.archivedAt);

  return (
    <Page title="Cycles" description="Sprint windows for the workspace.">
      {rows.length === 0 ? (
        <EmptyState
          title="No cycles"
          description="Cycles are scheduled iterations — create one when the team runs sprints."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Cycles">
            <Table.Header>
              <Table.Row>
                <Table.Head>Cycle</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Window</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((cycle) => (
                <Table.Row key={cycle.id}>
                  <Table.Cell>
                    {cycle.number !== null ? `#${cycle.number} ` : ""}
                    {cycle.name}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      variant={
                        cycle.status === "active"
                          ? "green"
                          : cycle.status === "upcoming"
                            ? "blue"
                            : "neutral"
                      }
                    >
                      {cycle.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {cycle.startDate
                      ? `${cycle.startDate.slice(0, 10)} → ${cycle.endDate?.slice(0, 10) ?? "—"}`
                      : "—"}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {formatRelative(cycle.updatedAt)}
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

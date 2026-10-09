import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useTeams } from "@/hooks/use-teams";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
} from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/")({
  component: WorkspaceOverview,
});

function useAnalytics(workspaceId: string, groupBy: "status" | "teamId") {
  return useQuery({
    queryKey: wsKey(workspaceId, "issue-analytics", groupBy),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issue-analytics", {
            params: {
              path: { organizationId: workspaceId },
              query: { groupBy },
            },
          })
        )
      ).groups,
  });
}

function WorkspaceOverview() {
  const workspace = useWorkspace();
  const byStatus = useAnalytics(workspace.id, "status");
  const byTeam = useAnalytics(workspace.id, "teamId");
  const teams = useTeams(workspace.id);

  const statusCount = new Map(
    (byStatus.data ?? []).map((g) => [g.group, g.count])
  );
  const teamCount = new Map(
    (byTeam.data ?? []).map((g) => [g.group ?? "", g.count])
  );
  const teamsWithIssues = (teams.data ?? [])
    .map((team) => ({ team, count: teamCount.get(team.id) ?? 0 }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count);

  const isPending = byStatus.isPending || byTeam.isPending || teams.isPending;
  const error = byStatus.error ?? byTeam.error ?? teams.error;
  const refetch = () => {
    void byStatus.refetch();
    void byTeam.refetch();
    void teams.refetch();
  };

  return (
    <Page title={workspace.name} description="Workspace overview">
      {isPending ? (
        <LoadingState label="Loading overview" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {ISSUE_STATUSES.map((status) => (
              <Link
                key={status}
                to="/$slug/issues"
                params={{ slug: workspace.slug }}
                search={{ status }}
              >
                <Badge variant={issueStatusVariant(status)}>
                  {ISSUE_STATUS_LABELS[status]} · {statusCount.get(status) ?? 0}
                </Badge>
              </Link>
            ))}
          </div>
          <LayerCard className="p-0">
            <Table aria-label="Teams">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Team</Table.Head>
                  <Table.Head>Issues</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {teamsWithIssues.map(({ team, count }) => (
                  <Table.Row key={team.id}>
                    <Table.Cell>
                      <Link
                        to="/$slug/issues"
                        params={{ slug: workspace.slug }}
                        search={{ team: team.id }}
                        className="text-kumo-link hover:underline"
                      >
                        <span className="text-kumo-subtle mr-2">
                          {team.key}
                        </span>
                        {team.name}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>{count}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        </>
      )}
    </Page>
  );
}

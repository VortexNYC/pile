import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Robot } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useTeams } from "@/hooks/use-teams";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import {
  formatRelative,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  sessionStatusVariant,
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
  const session = betterAuthClient.useSession();
  const byStatus = useAnalytics(workspace.id, "status");
  const byTeam = useAnalytics(workspace.id, "teamId");
  const teams = useTeams(workspace.id);

  const userId = session.data?.user.id;
  const mine = useQuery({
    queryKey: wsKey(workspace.id, "issues", "mine", userId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: workspace.id },
              query: { assigneeId: userId, limit: 5 },
            },
          })
        )
      ).issues,
    enabled: Boolean(userId),
  });
  const liveSessions = useQuery({
    queryKey: wsKey(workspace.id, "agent-sessions", "live"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/agent/sessions", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).sessions,
  });
  const TERMINAL = new Set(["completed", "failed", "canceled"]);
  const live = (liveSessions.data ?? [])
    .filter((s) => !TERMINAL.has(s.status))
    .slice(0, 5);
  const mineActive = (mine.data ?? []).filter((i) => !TERMINAL.has(i.status));

  const statusCount = new Map(
    (byStatus.data ?? []).map((g) => [g.group, g.count])
  );
  const teamCount = new Map(
    (byTeam.data ?? []).map((g) => [g.group ?? "", g.count])
  );
  const teamsWithIssues = (teams.data ?? [])
    .map((team) => ({ team, count: teamCount.get(team.id) ?? 0 }))
    .filter(({ count }) => count > 0)
    .toSorted((a, b) => b.count - a.count);

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
          <div className="grid gap-4 md:grid-cols-2">
            {mineActive.length > 0 ? (
              <LayerCard>
                <div className="border-b border-kumo-line px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-kumo-default">
                    Assigned to you
                  </span>
                  <Link
                    to="/$slug/issues"
                    params={{ slug: workspace.slug }}
                    className="text-xs text-kumo-link"
                  >
                    All issues →
                  </Link>
                </div>
                <ul className="divide-y divide-kumo-line">
                  {mineActive.map((issue) => (
                    <li key={issue.id}>
                      <Link
                        to="/$slug/issues/$issueId"
                        params={{
                          slug: workspace.slug,
                          issueId: issue.id,
                        }}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-kumo-tint"
                      >
                        {issue.identifier ? (
                          <span className="w-16 shrink-0 truncate text-xs font-medium text-kumo-subtle">
                            {issue.identifier}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">
                          {issue.title}
                        </span>
                        <Badge variant={issueStatusVariant(issue.status)}>
                          {ISSUE_STATUS_LABELS[issue.status]}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              </LayerCard>
            ) : null}
            {live.length > 0 ? (
              <LayerCard>
                <div className="border-b border-kumo-line px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-kumo-default flex items-center gap-2">
                    <Robot size={14} /> Active sessions
                  </span>
                  <Link
                    to="/$slug/sessions"
                    params={{ slug: workspace.slug }}
                    className="text-xs text-kumo-link"
                  >
                    All sessions →
                  </Link>
                </div>
                <ul className="divide-y divide-kumo-line">
                  {live.map((s) => (
                    <li key={s.id}>
                      <Link
                        to="/$slug/sessions/$sessionId"
                        params={{
                          slug: workspace.slug,
                          sessionId: s.id,
                        }}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-kumo-tint"
                      >
                        <Badge variant={sessionStatusVariant(s.status)}>
                          {s.status}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">
                          {s.label ?? s.id.slice(0, 8)}
                        </span>
                        <span className="text-xs text-kumo-subtle">
                          {formatRelative(s.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </LayerCard>
            ) : null}
          </div>
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

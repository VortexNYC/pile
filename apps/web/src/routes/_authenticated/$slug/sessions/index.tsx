import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Robot } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  derivedStatusVariant,
  formatRelative,
  sessionStatusVariant,
} from "@/lib/labels";

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export const Route = createFileRoute("/_authenticated/$slug/sessions/")({
  component: SessionsList,
});

function SessionsList() {
  const workspace = useWorkspace();

  const sessions = useQuery({
    queryKey: wsKey(workspace.id, "agent-sessions"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/agent/sessions", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).sessions,
    placeholderData: keepPreviousData,
    // Live surface — refresh while anything is running.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => !TERMINAL.has(s.status))
        ? 3000
        : false,
  });

  const ordered = (sessions.data ?? [])
    .toSorted(
      (a, b) =>
        Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    )
    .slice(0, 100);

  return (
    <Page title="Sessions" description="Agent sessions across the workspace.">
      {sessions.isPending ? (
        <LoadingState label="Loading sessions" />
      ) : sessions.isError ? (
        <ErrorState
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={<Robot size={40} />}
          title="No sessions yet"
          description="Dispatch an agent from the CLI or an issue to see it here."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Agent sessions">
            <Table.Header>
              <Table.Row>
                <Table.Head>Session</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Provider</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {ordered.map((session) => (
                <Table.Row key={session.id}>
                  <Table.Cell>
                    <Link
                      to="/$slug/sessions/$sessionId"
                      params={{
                        slug: workspace.slug,
                        sessionId: session.id,
                      }}
                      className="text-kumo-link hover:underline"
                    >
                      {session.label ?? session.id.slice(0, 8)}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={sessionStatusVariant(session.status)}>
                      {session.status}
                    </Badge>
                    {derivedStatusVariant(session.derivedStatus) ? (
                      <Badge
                        variant={
                          derivedStatusVariant(session.derivedStatus) ??
                          "neutral"
                        }
                        className="ml-2"
                      >
                        {session.derivedStatus?.replace("_", " ")}
                      </Badge>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell>{session.provider}</Table.Cell>
                  <Table.Cell>{formatRelative(session.updatedAt)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
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
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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
        <div className="flex flex-col gap-5">
          {(
            [
              ["Live", ordered.filter((s) => !TERMINAL.has(s.status))],
              [
                "Today",
                ordered.filter(
                  (s) =>
                    TERMINAL.has(s.status) &&
                    Date.now() - Date.parse(s.updatedAt) < DAY_MS
                ),
              ],
              [
                "This week",
                ordered.filter(
                  (s) =>
                    TERMINAL.has(s.status) &&
                    Date.now() - Date.parse(s.updatedAt) >= DAY_MS &&
                    Date.now() - Date.parse(s.updatedAt) < WEEK_MS
                ),
              ],
              [
                "Older",
                ordered.filter(
                  (s) =>
                    TERMINAL.has(s.status) &&
                    Date.now() - Date.parse(s.updatedAt) >= WEEK_MS
                ),
              ],
            ] as const
          ).map(([group, rows]) =>
            rows.length === 0 ? null : (
              <div key={group} className="flex flex-col">
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  <span className="text-xs font-medium text-kumo-subtle uppercase">
                    {group}
                  </span>
                  <span className="text-xs text-kumo-subtle">
                    {rows.length}
                  </span>
                </div>
                <LayerCard className="p-0">
                  <div className="divide-y divide-kumo-line">
                    {rows.map((session) => (
                      <Link
                        key={session.id}
                        to="/$slug/sessions/$sessionId"
                        params={{
                          slug: workspace.slug,
                          sessionId: session.id,
                        }}
                        className="flex h-11 items-center gap-3 px-4 hover:bg-kumo-tint"
                      >
                        <Badge variant={sessionStatusVariant(session.status)}>
                          {session.status}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                          {session.label ?? session.id.slice(0, 8)}
                        </span>
                        {derivedStatusVariant(session.derivedStatus) ? (
                          <Badge
                            variant={
                              derivedStatusVariant(session.derivedStatus) ??
                              "neutral"
                            }
                          >
                            {session.derivedStatus?.replace("_", " ")}
                          </Badge>
                        ) : null}
                        <span className="text-xs text-kumo-subtle">
                          {session.provider}
                        </span>
                        <span className="w-16 shrink-0 text-right text-xs text-kumo-subtle">
                          {formatRelative(session.updatedAt)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </LayerCard>
              </div>
            )
          )}
        </div>
      )}
    </Page>
  );
}

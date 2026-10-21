import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Robot } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityHover } from "@/components/entity-hover";
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

type SessionRow = NonNullable<
  ReturnType<typeof useAgentSessions>["data"]
>[number];

/** The workspace session list, scoped to a lane of work when `issueId` or
 * `agentSlug` is passed (PILE-453). Shared with the sessions route — the
 * page derives its agent filter options from the same unscoped query. */
export function useAgentSessions({
  issueId,
  agentSlug,
}: { issueId?: string; agentSlug?: string } = {}) {
  const workspace = useWorkspace();
  return useQuery({
    queryKey: wsKey(workspace.id, "sessions", { issueId, agentSlug }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/agent/sessions", {
            params: {
              path: { organizationId: workspace.id },
              query: { issueId, agentSlug },
            },
          })
        )
      ).sessions,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => !TERMINAL.has(s.status))
        ? 3000
        : false,
  });
}

function SessionLink({ session }: { session: SessionRow }) {
  const workspace = useWorkspace();
  return (
    <EntityHover
      meta={
        <>
          <Badge variant={sessionStatusVariant(session.status)}>
            {session.status}
          </Badge>
          <span className="text-xs text-kumo-subtle">{session.provider}</span>
        </>
      }
      title={session.label ?? session.id.slice(0, 8)}
    >
      <Link
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
            variant={derivedStatusVariant(session.derivedStatus) ?? "neutral"}
          >
            {session.derivedStatus?.replace("_", " ")}
          </Badge>
        ) : null}
        <span className="text-xs text-kumo-subtle">{session.provider}</span>
        <span className="w-16 shrink-0 text-right text-xs text-kumo-subtle">
          {formatRelative(session.updatedAt)}
        </span>
      </Link>
    </EntityHover>
  );
}

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5">
      <span className="text-xs font-medium text-kumo-subtle uppercase">
        {title}
      </span>
      <span className="text-xs text-kumo-subtle">{count}</span>
    </div>
  );
}

/** Agent sessions — Live/Today/Week/Older groups, or `groupBy` scope
 * groups when a surface wants each lane filed under its agent or issue.
 * Reused by the sessions route and the Issues tab. `issueId`/`agentSlug`
 * scope the list to a lane of work (PILE-453 — no more flat dumps). */
export function SessionsList({
  issueId,
  agentSlug,
  groupBy,
  groupLabels,
}: {
  issueId?: string;
  agentSlug?: string;
  groupBy?: "agent" | "issue";
  /** Display name per scope key (agentId or issueId); raw key otherwise. */
  groupLabels?: Readonly<Record<string, string>>;
} = {}) {
  const sessions = useAgentSessions({ issueId, agentSlug });

  if (sessions.isPending) return <LoadingState label="Loading sessions" />;
  if (sessions.isError) {
    return (
      <ErrorState
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
      />
    );
  }

  const ordered = (sessions.data ?? [])
    .toSorted(
      (a, b) =>
        Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    )
    .slice(0, 100);

  if (ordered.length === 0) {
    return (
      <EmptyState
        icon={<Robot size={40} />}
        title="No sessions yet"
        description="Dispatch an agent from the CLI or an issue to see it here."
      />
    );
  }

  if (groupBy) {
    const scopeKey = (s: SessionRow) =>
      groupBy === "agent" ? s.agentId : s.issueId;
    const buckets = new Map<string, SessionRow[]>();
    for (const session of ordered) {
      const key = scopeKey(session);
      const rows = buckets.get(key) ?? [];
      rows.push(session);
      buckets.set(key, rows);
    }
    const groups = [...buckets.entries()].toSorted(
      (a, b) =>
        Date.parse(b[1][0]?.updatedAt ?? "") -
        Date.parse(a[1][0]?.updatedAt ?? "")
    );
    return (
      <div className="flex flex-col gap-5">
        {groups.map(([key, rows]) => (
          <div key={key} className="flex flex-col">
            <GroupHeader
              title={groupLabels?.[key] ?? rows[0]?.label ?? key}
              count={rows.length}
            />
            <LayerCard className="p-0">
              <div className="divide-y divide-kumo-line">
                {rows.map((session) => (
                  <SessionLink key={session.id} session={session} />
                ))}
              </div>
            </LayerCard>
          </div>
        ))}
      </div>
    );
  }

  return (
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
            <GroupHeader title={group} count={rows.length} />
            <LayerCard className="p-0">
              <div className="divide-y divide-kumo-line">
                {rows.map((session) => (
                  <SessionLink key={session.id} session={session} />
                ))}
              </div>
            </LayerCard>
          </div>
        )
      )}
    </div>
  );
}

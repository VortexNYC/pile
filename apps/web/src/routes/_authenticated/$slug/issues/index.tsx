import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { ListChecks, Plus } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useDeferredValue } from "react";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useTeams } from "@/hooks/use-teams";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUSES,
  isIssueStatus,
  type IssueStatus,
  issueStatusVariant,
  PRIORITY_LABELS,
  priorityVariant,
} from "@/lib/labels";

const ALL = "all";

interface IssuesSearch {
  status?: IssueStatus;
  team?: string;
  q?: string;
}

export const Route = createFileRoute("/_authenticated/$slug/issues/")({
  component: IssuesList,
  validateSearch: (search: Record<string, unknown>): IssuesSearch => ({
    status: isIssueStatus(search.status) ? search.status : undefined,
    team:
      typeof search.team === "string" && search.team.length > 0
        ? search.team
        : undefined,
    q:
      typeof search.q === "string" && search.q.length > 0
        ? search.q
        : undefined,
  }),
});

function IssuesList() {
  const workspace = useWorkspace();
  const { status, team, q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = useDeferredValue(q);
  const teams = useTeams(workspace.id);

  const issues = useQuery({
    queryKey: wsKey(workspace.id, "issues", { status, team, search }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 100, status, teamId: team, search },
            },
          })
        )
      ).issues,
    placeholderData: keepPreviousData,
  });

  return (
    <Page
      title="Issues"
      description="Everything your team is tracking."
      actions={
        <Button
          variant="primary"
          icon={<Plus />}
          onClick={() =>
            void navigate({
              to: "/$slug/issues/new",
              params: { slug: workspace.slug },
            })
          }
        >
          New issue
        </Button>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <Input
            aria-label="Search issues"
            placeholder="Search issues"
            defaultValue={q ?? ""}
            onChange={(event) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  q: event.target.value || undefined,
                }),
                replace: true,
              })
            }
          />
        </div>
        <Select
          aria-label="Filter by status"
          value={status ?? ALL}
          onValueChange={(value) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                status: isIssueStatus(value) ? value : undefined,
              }),
              replace: true,
            })
          }
          renderValue={(v) =>
            isIssueStatus(v) ? ISSUE_STATUS_LABELS[v] : "All statuses"
          }
        >
          <Select.Option value={ALL}>All statuses</Select.Option>
          {ISSUE_STATUSES.map((s) => (
            <Select.Option key={s} value={s}>
              {ISSUE_STATUS_LABELS[s]}
            </Select.Option>
          ))}
        </Select>
        <Select
          aria-label="Filter by team"
          value={team ?? ALL}
          onValueChange={(value) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                team:
                  typeof value === "string" && value !== ALL
                    ? value
                    : undefined,
              }),
              replace: true,
            })
          }
          renderValue={(v) =>
            teams.data?.find((t) => t.id === v)?.name ?? "All teams"
          }
        >
          <Select.Option value={ALL}>All teams</Select.Option>
          {(teams.data ?? []).map((t) => (
            <Select.Option key={t.id} value={t.id}>
              {t.key} — {t.name}
            </Select.Option>
          ))}
        </Select>
      </div>
      {issues.isPending ? (
        <LoadingState label="Loading issues" />
      ) : issues.isError ? (
        <ErrorState
          error={issues.error}
          onRetry={() => void issues.refetch()}
        />
      ) : issues.data.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={40} />}
          title={status || q ? "No matching issues" : "No issues yet"}
          description={
            status || q
              ? "Try a different search or status."
              : "Create the first issue to start tracking work."
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {ISSUE_STATUSES.map((group) => {
            const rows = issues.data.filter((issue) => issue.status === group);
            if (rows.length === 0) return null;
            return (
              <div key={group} className="flex flex-col">
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  <Badge variant={issueStatusVariant(group)}>
                    {ISSUE_STATUS_LABELS[group]}
                  </Badge>
                  <span className="text-xs text-kumo-subtle">
                    {rows.length}
                  </span>
                </div>
                <LayerCard className="p-0">
                  <div className="divide-y divide-kumo-line">
                    {rows.map((issue) => (
                      <Link
                        key={issue.id}
                        to="/$slug/issues/$issueId"
                        params={{
                          slug: workspace.slug,
                          issueId: issue.id,
                        }}
                        className="flex h-11 items-center gap-3 px-4 hover:bg-kumo-tint"
                      >
                        {issue.identifier ? (
                          <span className="w-16 shrink-0 truncate text-sm font-medium text-kumo-subtle">
                            {issue.identifier}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                          {issue.title}
                        </span>
                        <Badge variant={priorityVariant(issue.priority)}>
                          {PRIORITY_LABELS[issue.priority]}
                        </Badge>
                        <span className="w-16 shrink-0 text-right text-xs text-kumo-subtle">
                          {formatRelative(issue.updatedAt)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </LayerCard>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ListChecks, Plus, X } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";

import { IssueContextMenu } from "@/components/issue-context-menu";
import {
  DEFAULT_DISPLAY,
  IssueDisplayMenu,
} from "@/components/issue-display-menu";
import { IssueFieldMenu } from "@/components/issue-field-menu";
import { EMPTY_FILTER, IssueFilter } from "@/components/issue-filter";
import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { IssuePeek } from "@/components/peek";
import { PeekDrawer } from "@/components/peek-drawer";
import { PrChip } from "@/components/pr-chip";
import { ProjectsList } from "@/components/projects-list";
import { SessionsList } from "@/components/sessions-list";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { IssueStatusIcon } from "@/components/status-icon";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUSES,
  isIssueStatus,
  isPriority,
  type IssueStatus,
  PRIORITIES,
  PRIORITY_LABELS,
  priorityVariant,
} from "@/lib/labels";

interface IssuesSearch {
  status?: IssueStatus;
  team?: string;
  q?: string;
  tab?: "issues" | "projects" | "sessions";
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
  const { status, q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = useDeferredValue(q);

  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [display, setDisplay] = useState(DEFAULT_DISPLAY);
  const [peekedId, setPeekedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const bulk = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      unwrap(
        api.POST("/workspaces/{organizationId}/issues/batch", {
          params: { path: { organizationId: workspace.id } },
          body: { ids: [...selected], patch },
        })
      ),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "issues"),
      });
    },
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
  const moveStatus = useMutation({
    mutationFn: (args: { id: string; status: string }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/issues/{id}", {
          params: { path: { organizationId: workspace.id, id: args.id } },
          body: { status: args.status } as never,
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "issues"),
      }),
  });
  const onDragEnd = (event: DragEndEvent) => {
    const issueId = String(event.active.id);
    const status = event.over ? String(event.over.id) : null;
    if (status && isIssueStatus(status)) {
      moveStatus.mutate({ id: issueId, status });
    }
  };
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const issues = useQuery({
    queryKey: wsKey(workspace.id, "issues", { search }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 100, search },
            },
          })
        )
      ).issues,
    placeholderData: keepPreviousData,
  });
  const peeked = (issues.data ?? []).find((i) => i.id === peekedId) ?? null;

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
      <>
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
          <IssueFilter
            organizationId={workspace.id}
            value={filter}
            onChange={setFilter}
          />
          <IssueDisplayMenu value={display} onChange={setDisplay} />
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
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="flex flex-col gap-5">
              {ISSUE_STATUSES.map((group) => {
                const rows = issues.data.filter(
                  (issue) =>
                    issue.status === group &&
                    (filter.statuses.length === 0 ||
                      filter.statuses.includes(issue.status)) &&
                    (filter.priorities.length === 0 ||
                      filter.priorities.includes(issue.priority)) &&
                    (filter.assignees.length === 0 ||
                      filter.assignees.includes(issue.assigneeId ?? "")) &&
                    (filter.projects.length === 0 ||
                      filter.projects.includes(issue.projectId ?? "")) &&
                    (filter.teams.length === 0 ||
                      filter.teams.includes(issue.teamId))
                );
                if (rows.length === 0) return null;
                return (
                  <div key={group} className="flex flex-col">
                    <div className="flex items-center gap-2 px-1 pb-1.5">
                      <IssueStatusIcon status={group} />
                      <span className="text-sm font-medium text-kumo-default">
                        {ISSUE_STATUS_LABELS[group]}
                      </span>
                      <span className="text-xs text-kumo-subtle">
                        {rows.length}
                      </span>
                    </div>
                    <LayerCard className="p-0">
                      <div className="divide-y divide-kumo-line">
                        {rows.map((issue) => (
                          <IssueContextMenu key={issue.id} issue={issue}>
                            <IssuePeek issue={issue}>
                              <Link
                                to="/$slug/issues/$issueId"
                                params={{
                                  slug: workspace.slug,
                                  issueId: issue.id,
                                }}
                                onClick={(e) => {
                                  // modified clicks keep native nav — plain
                                  // click opens the peek drawer instead.
                                  if (e.metaKey || e.ctrlKey || e.shiftKey)
                                    return;
                                  e.preventDefault();
                                  setPeekedId(issue.id);
                                }}
                                className={`group flex h-11 items-center gap-3 px-4 hover:bg-kumo-tint ${
                                  selected.has(issue.id) ? "bg-kumo-tint" : ""
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${issue.title}`}
                                  checked={selected.has(issue.id)}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    toggleSelected(issue.id);
                                  }}
                                  onChange={() => undefined}
                                  className={`accent-kumo-brand size-4 shrink-0 ${
                                    selected.size === 0
                                      ? "opacity-0 transition-opacity group-hover:opacity-100"
                                      : ""
                                  }`}
                                />
                                <IssueStatusIcon status={issue.status} />
                                {issue.identifier ? (
                                  <span className="w-16 shrink-0 truncate text-sm font-medium text-kumo-subtle">
                                    {issue.identifier}
                                  </span>
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                                  {issue.title}
                                </span>
                                <PrChip issue={issue} />
                                <IssueFieldMenu
                                  issue={issue}
                                  field="priority"
                                  options={PRIORITIES}
                                  labels={PRIORITY_LABELS}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => e.preventDefault()}
                                    className="cursor-pointer"
                                  >
                                    <Badge
                                      variant={priorityVariant(issue.priority)}
                                    >
                                      {PRIORITY_LABELS[issue.priority]}
                                    </Badge>
                                  </button>
                                </IssueFieldMenu>
                                <span className="w-16 shrink-0 text-right text-xs text-kumo-subtle">
                                  {formatRelative(issue.updatedAt)}
                                </span>
                              </Link>
                            </IssuePeek>
                          </IssueContextMenu>
                        ))}
                      </div>
                    </LayerCard>
                  </div>
                );
              })}
            </div>
          </DndContext>
        )}
        {peeked ? (
          <PeekDrawer
            open={!!peeked}
            onOpenChange={(o) => !o && setPeekedId(null)}
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                {peeked.identifier ? (
                  <span className="text-xs font-medium text-kumo-subtle">
                    {peeked.identifier}
                  </span>
                ) : null}
                <IssueStatusIcon status={peeked.status} />
                <Badge variant={priorityVariant(peeked.priority)}>
                  {PRIORITY_LABELS[peeked.priority]}
                </Badge>
                <PrChip issue={peeked} />
              </div>
              <h2 className="text-xl font-semibold text-kumo-default">
                {peeked.title}
              </h2>
              {peeked.description ? (
                <Markdown
                  workspaceSlug={workspace.slug}
                  content={peeked.description}
                />
              ) : (
                <p className="text-sm text-kumo-subtle">No description.</p>
              )}
              <Link
                to="/$slug/issues/$issueId"
                params={{ slug: workspace.slug, issueId: peeked.id }}
                className="text-sm text-kumo-link hover:underline"
              >
                Open full issue →
              </Link>
            </div>
          </PeekDrawer>
        ) : null}
        {selected.size > 0 ? (
          <div className="bg-kumo-canvas border-kumo-line fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border px-4 py-2 shadow-lg">
            <span className="text-sm text-kumo-default">
              {selected.size} selected
            </span>
            <Select
              aria-label="Set status"
              value=""
              disabled={bulk.isPending}
              onValueChange={(v) => {
                if (isIssueStatus(v)) bulk.mutate({ status: v });
              }}
              renderValue={() => "Set status"}
            >
              {ISSUE_STATUSES.map((s) => (
                <Select.Option key={s} value={s}>
                  {ISSUE_STATUS_LABELS[s]}
                </Select.Option>
              ))}
            </Select>
            <Select
              aria-label="Set priority"
              value=""
              disabled={bulk.isPending}
              onValueChange={(v) => {
                if (isPriority(v)) bulk.mutate({ priority: v });
              }}
              renderValue={() => "Set priority"}
            >
              {PRIORITIES.map((p) => (
                <Select.Option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </Select.Option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              icon={<X />}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </>

      <div className="mt-8 flex flex-col gap-2 border-t border-kumo-line pt-4">
        <h2 className="text-sm font-medium text-kumo-subtle px-1">Projects</h2>
        <ProjectsList />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-kumo-subtle px-1">Sessions</h2>
        <SessionsList />
      </div>
    </Page>
  );
}

function DroppableGroup({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={
        isOver ? "rounded-lg bg-kumo-tint/60 ring-1 ring-kumo-brand" : undefined
      }
    >
      {children}
    </div>
  );
}

function DraggableRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={isDragging ? "opacity-40" : undefined}
    >
      {children}
    </div>
  );
}

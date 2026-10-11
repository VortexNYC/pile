import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { IssueComments } from "@/components/comments";
import { IssueFieldMenu } from "@/components/issue-field-menu";
import { IssueForm, type IssueFormValues } from "@/components/issue-form";
import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { PrChip } from "@/components/pr-chip";
import { ShareButton } from "@/components/share-button";
import { ErrorState, LoadingState } from "@/components/states";
import { useTeams } from "@/hooks/use-teams";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import {
  formatRelative,
  isTicketStatus,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  PRIORITIES,
  PRIORITY_LABELS,
  priorityVariant,
  sessionStatusVariant,
  TICKET_STATUS_LABELS,
  ticketStatusVariant,
} from "@/lib/labels";
import { prChip } from "@/lib/pull-request";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/issues/$issueId")({
  component: IssueDetail,
});

function RailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-kumo-subtle mb-2">{title}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function RailLink({
  to,
  params,
  children,
}: {
  to: string;
  params: Record<string, string>;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params}
      className="text-sm text-kumo-link hover:underline truncate"
    >
      {children}
    </Link>
  );
}

function IssueDetail() {
  const { issueId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const key = wsKey(organizationId, "issues", issueId);
  const path = { organizationId, id: issueId };
  const teams = useTeams(organizationId);

  const issue = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
        })
      ),
  });

  const documents = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "documents"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/documents", {
            params: {
              path: { organizationId, issueId },
            },
          })
        )
      ).documents,
  });

  const sessions = useQuery({
    queryKey: wsKey(organizationId, "agent-sessions", "issue", issueId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/agent/sessions", {
            params: {
              path: { organizationId },
              query: { issueId },
            },
          })
        )
      ).sessions,
  });

  const externalLinks = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "external-links"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/issues/{issueId}/external-links",
            { params: { path: { organizationId, issueId } } }
          )
        )
      ).links,
  });

  const attachments = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "attachments"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/attachments", {
            params: {
              path: { organizationId, issueId },
            },
          })
        )
      ).attachments,
  });

  const relations = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "relations"),
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/issues/{issueId}/relations", {
          params: { path: { organizationId, issueId } },
        })
      ),
  });

  const subscribers = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "subscribers"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/subscribers", {
            params: {
              path: { organizationId, issueId },
            },
          })
        )
      ).subscribers,
  });

  const labels = useQuery({
    queryKey: wsKey(organizationId, "labels"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/labels", {
            params: { path: { organizationId } },
          })
        )
      ).labels,
  });

  const projects = useQuery({
    queryKey: wsKey(organizationId, "projects"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/projects", {
            params: { path: { organizationId } },
          })
        )
      ).projects,
  });

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

  const parent = useQuery({
    queryKey: wsKey(organizationId, "issues", "parent-of", issueId),
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/issues/{id}", {
          params: { path: { organizationId, id: data?.parentId ?? "" } },
        })
      ),
    enabled: !!issue.data?.parentId,
  });

  const children = useQuery({
    queryKey: wsKey(organizationId, "issues", "children-of", issueId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId },
              query: { parentId: issueId },
            },
          })
        )
      ).issues,
  });

  const tickets = useQuery({
    queryKey: wsKey(organizationId, "tickets", "issue", issueId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId },
              query: { issueId },
            },
          })
        )
      ).tickets,
  });

  const approvals = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "approvals"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/approvals", {
            params: { path: { organizationId, issueId } },
          })
        )
      ).approvals,
  });

  const history = useQuery({
    queryKey: wsKey(organizationId, "issues", issueId, "history"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/history", {
            params: { path: { organizationId, issueId } },
          })
        )
      ).history,
  });

  const members = useQuery({
    queryKey: wsKey(organizationId, "members"),
    queryFn: async () => {
      const res = await betterAuthClient.organization.listMembers({
        query: { organizationId },
      });
      return res.data?.members ?? [];
    },
  });

  const save = useMutation({
    mutationFn: (values: IssueFormValues) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
          body: {
            title: values.title,
            description: values.description.trim() || null,
            status: values.status,
            priority: values.priority,
          },
        })
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "issues"),
      });
      setEditing(false);
      toastSuccess("Issue updated");
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
        })
      ),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "issues"),
      });
      toastSuccess("Issue deleted");
      await navigate({ to: "/$slug/issues", params: { slug: workspace.slug } });
    },
    onError: (error) => toastError(error),
  });

  if (issue.isPending) return <LoadingState label="Loading issue" />;
  if (issue.isError) {
    return (
      <Page title="Issue">
        <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />
      </Page>
    );
  }
  const data = issue.data;
  const team = teams.data?.find((t) => t.id === data.teamId);
  const docs = documents.data ?? [];
  const issueSessions = (sessions.data ?? []).toSorted(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
  const links = externalLinks.data ?? [];
  const files = attachments.data ?? [];
  const rels = relations.data;
  const allRelations = [
    ...(rels?.relations ?? []),
    ...(rels?.inverseRelations ?? []),
  ];
  const watchers = subscribers.data ?? [];
  const issueLabels = (data.labelIds ?? "")
    .split(",")
    .filter((id) => id.length > 0)
    .map((id) => labels.data?.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => !!l);
  const project = data.projectId
    ? projects.data?.find((p) => p.id === data.projectId)
    : undefined;
  const cycle = data.cycleId
    ? cycles.data?.find((c) => c.id === data.cycleId)
    : undefined;
  const assignee = data.assigneeId
    ? data.assigneeId.startsWith("lane:")
      ? "agent lane"
      : (members.data?.find(
          (m) => m.user?.id === data.assigneeId || m.id === data.assigneeId
        )?.user?.name ??
        members.data?.find(
          (m) => m.user?.id === data.assigneeId || m.id === data.assigneeId
        )?.user?.email)
    : undefined;
  const subIssues = children.data ?? [];
  const linkedTickets = tickets.data ?? [];
  const approvalRows = approvals.data ?? [];
  const historyRows = history.data ?? [];

  const resolveActor = (id: string | null | undefined) =>
    id
      ? (members.data?.find((m) => m.user?.id === id || m.id === id)?.user
          ?.name ??
        members.data?.find((m) => m.user?.id === id || m.id === id)?.user
          ?.email ??
        undefined)
      : undefined;

  return (
    <Page
      title={data.title}
      description={
        <>
          <Link
            to="/$slug/issues"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Issues
          </Link>
          {data.identifier ? ` / ${data.identifier}` : null} · updated{" "}
          {formatRelative(data.updatedAt)}
        </>
      }
      actions={
        editing ? null : (
          <>
            <ShareButton
              organizationId={workspace.id}
              kind="issue"
              id={data.id}
            />
            <Button icon={<PencilSimple />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="secondary-destructive"
              icon={<Trash />}
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm("Delete this issue? This can't be undone."))
                  remove.mutate();
              }}
            >
              Delete
            </Button>
          </>
        )
      }
    >
      <div className="flex gap-8 min-w-0">
        {/* center column: title context, description, sub-issues, activity */}
        <div className="flex-1 min-w-0 flex flex-col gap-6">
          {/* the rail is lg-only; keep the PR chip visible below that */}
          {prChip(data) ? (
            <div className="lg:hidden">
              <PrChip issue={data} link />
            </div>
          ) : null}
          {editing ? (
            <LayerCard>
              <LayerCard.Primary className="p-6">
                <IssueForm
                  initial={{
                    title: data.title,
                    description: data.description ?? "",
                    status: data.status,
                    priority: data.priority,
                  }}
                  submitLabel="Save changes"
                  pending={save.isPending}
                  onSubmit={(values) => save.mutate(values)}
                  onCancel={() => setEditing(false)}
                />
              </LayerCard.Primary>
            </LayerCard>
          ) : data.description ? (
            <Markdown
              workspaceSlug={workspace.slug}
              content={data.description}
            />
          ) : (
            <Text variant="secondary">No description.</Text>
          )}

          {files.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-kumo-subtle">
                Attachments
              </h3>
              {files.map((file) => {
                const isImage = file.subtitle?.startsWith("image/");
                return (
                  <div key={file.id} className="text-sm">
                    {file.url ? (
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-kumo-link hover:underline"
                      >
                        {file.title ?? file.url}
                      </a>
                    ) : (
                      (file.title ?? file.r2Key ?? file.id)
                    )}
                    {isImage && file.url ? (
                      <img
                        src={file.url}
                        alt={file.title ?? "Attachment"}
                        className="mt-2 max-w-md rounded border border-kumo-line"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {subIssues.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-kumo-subtle">
                  Sub-issues{" "}
                  <span>
                    {subIssues.filter((s) => s.status === "done").length}/
                    {subIssues.length}
                  </span>
                </h3>
                <div
                  role="progressbar"
                  aria-label="Sub-issue progress"
                  aria-valuenow={Math.round(
                    (subIssues.filter((s) => s.status === "done").length /
                      subIssues.length) *
                      100
                  )}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-1.5 w-24 overflow-hidden rounded-full bg-kumo-tint"
                >
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{
                      width: `${Math.round(
                        (subIssues.filter((s) => s.status === "done").length /
                          subIssues.length) *
                          100
                      )}%`,
                    }}
                  />
                </div>
              </div>
              <ul className="flex flex-col border-t border-kumo-line">
                {subIssues.map((sub) => (
                  <li key={sub.id}>
                    <Link
                      to="/$slug/issues/$issueId"
                      params={{ slug: workspace.slug, issueId: sub.id }}
                      className="flex items-center gap-2.5 h-10 border-b border-kumo-line text-sm hover:bg-kumo-control min-w-0 px-1"
                    >
                      <Badge variant={issueStatusVariant(sub.status)}>
                        {sub.status.replace("_", " ")}
                      </Badge>
                      {sub.identifier ? (
                        <span className="text-kumo-subtle shrink-0 text-xs">
                          {sub.identifier}
                        </span>
                      ) : null}
                      <span className="truncate">{sub.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-kumo-line" />

          <IssueComments
            issueId={issueId}
            history={historyRows}
            actorName={resolveActor}
            resolveValue={(field, value) => {
              switch (field) {
                case "status":
                  return ISSUE_STATUS_LABELS[
                    value as keyof typeof ISSUE_STATUS_LABELS
                  ];
                case "priority":
                  return PRIORITY_LABELS[value as keyof typeof PRIORITY_LABELS];
                case "assignee_id":
                  return resolveActor(value);
                case "team_id":
                  return teams.data?.find((tm) => tm.id === value)?.name;
                case "project_id":
                  return projects.data?.find((pr) => pr.id === value)?.name;
                case "cycle_id":
                  return cycles.data?.find((cy) => cy.id === value)?.name;
                default:
                  return undefined;
              }
            }}
          />
        </div>

        {/* properties rail */}
        <aside className="hidden lg:block w-72 shrink-0 border-l border-kumo-line pl-6">
          <div className="flex flex-col gap-6">
            <RailSection title="Properties">
              <div className="flex items-center gap-2 text-sm">
                <IssueFieldMenu
                  issue={data}
                  field="status"
                  options={ISSUE_STATUSES}
                  labels={ISSUE_STATUS_LABELS}
                >
                  <button type="button" className="cursor-pointer">
                    <Badge variant={issueStatusVariant(data.status)}>
                      {ISSUE_STATUS_LABELS[data.status]}
                    </Badge>
                  </button>
                </IssueFieldMenu>
                <IssueFieldMenu
                  issue={data}
                  field="priority"
                  options={PRIORITIES}
                  labels={PRIORITY_LABELS}
                >
                  <button type="button" className="cursor-pointer">
                    <Badge variant={priorityVariant(data.priority)}>
                      {PRIORITY_LABELS[data.priority]}
                    </Badge>
                  </button>
                </IssueFieldMenu>
              </div>
              {assignee ? (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-kumo-subtle">Assignee</span>
                  <span>{assignee}</span>
                </div>
              ) : null}
              {team ? (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-kumo-subtle">Team</span>
                  <span>
                    {team.key} — {team.name}
                  </span>
                </div>
              ) : null}
              {project ? (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-kumo-subtle">Project</span>
                  <RailLink
                    to="/$slug/projects/$projectId"
                    params={{
                      slug: workspace.slug,
                      projectId: project.id,
                    }}
                  >
                    {project.name}
                  </RailLink>
                </div>
              ) : null}
              {cycle ? (
                <div className="text-sm flex items-center gap-2">
                  <span className="text-kumo-subtle">Cycle</span>
                  <span>{cycle.name}</span>
                </div>
              ) : null}
            </RailSection>

            {prChip(data) ? (
              <RailSection title="Pull request">
                <PrChip issue={data} link />
              </RailSection>
            ) : null}

            {issueLabels.length > 0 ? (
              <RailSection title="Labels">
                <div className="flex flex-wrap gap-1.5">
                  {issueLabels.map((label) => (
                    <Badge key={label.id} variant="neutral">
                      {label.name}
                    </Badge>
                  ))}
                </div>
              </RailSection>
            ) : null}

            {parent.data ? (
              <RailSection title="Parent">
                <RailLink
                  to="/$slug/issues/$issueId"
                  params={{
                    slug: workspace.slug,
                    issueId: parent.data.id,
                  }}
                >
                  {parent.data.identifier
                    ? `${parent.data.identifier} ${parent.data.title}`
                    : parent.data.title}
                </RailLink>
              </RailSection>
            ) : null}

            {approvalRows.length > 0 ? (
              <RailSection title="Approvals">
                {approvalRows.map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <Badge
                      variant={
                        a.status === "approved"
                          ? "green"
                          : a.status === "rejected"
                            ? "red"
                            : "orange"
                      }
                    >
                      {a.status}
                    </Badge>
                    <span className="text-xs text-kumo-subtle truncate">
                      {a.comment ?? "requested"} · {formatRelative(a.createdAt)}
                    </span>
                  </div>
                ))}
              </RailSection>
            ) : null}

            {linkedTickets.length > 0 ? (
              <RailSection title="Support tickets">
                {linkedTickets.map((ticket) => (
                  <div key={ticket.id} className="flex items-center gap-2">
                    <Badge variant={ticketStatusVariant(ticket.status)}>
                      {isTicketStatus(ticket.status)
                        ? TICKET_STATUS_LABELS[ticket.status]
                        : ticket.status}
                    </Badge>
                    <RailLink
                      to="/$slug/tickets/$ticketId"
                      params={{
                        slug: workspace.slug,
                        ticketId: ticket.id,
                      }}
                    >
                      {ticket.title}
                    </RailLink>
                  </div>
                ))}
              </RailSection>
            ) : null}

            {allRelations.length > 0 ? (
              <RailSection title="Related">
                {allRelations.map((rel) => {
                  const otherId =
                    rel.fromIssueId === issueId
                      ? rel.toIssueId
                      : rel.fromIssueId;
                  return (
                    <div key={rel.id} className="flex items-center gap-2">
                      <Badge variant="neutral">{rel.type}</Badge>
                      <RailLink
                        to="/$slug/issues/$issueId"
                        params={{ slug: workspace.slug, issueId: otherId }}
                      >
                        View issue
                      </RailLink>
                    </div>
                  );
                })}
              </RailSection>
            ) : null}

            {docs.length > 0 ? (
              <RailSection title="Documents">
                {docs.map((doc) => (
                  <RailLink
                    key={doc.id}
                    to="/$slug/documents/$documentId"
                    params={{ slug: workspace.slug, documentId: doc.id }}
                  >
                    {doc.title}
                  </RailLink>
                ))}
              </RailSection>
            ) : null}

            {links.length > 0 ? (
              <RailSection title="Links">
                {links.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-kumo-link hover:underline truncate"
                  >
                    {link.label ?? link.url}
                  </a>
                ))}
              </RailSection>
            ) : null}

            {issueSessions.length > 0 ? (
              <RailSection title="Sessions">
                {issueSessions.slice(0, 5).map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <Badge variant={sessionStatusVariant(s.status)}>
                      {s.derivedStatus?.replace("_", " ") ?? s.status}
                    </Badge>
                    <RailLink
                      to="/$slug/sessions/$sessionId"
                      params={{ slug: workspace.slug, sessionId: s.id }}
                    >
                      {s.label ?? s.id.slice(0, 8)}
                    </RailLink>
                  </div>
                ))}
                {issueSessions.length > 5 ? (
                  <span className="text-xs text-kumo-subtle">
                    +{issueSessions.length - 5} more
                  </span>
                ) : null}
              </RailSection>
            ) : null}

            {watchers.length > 0 ? (
              <RailSection title="Subscribers">
                <div className="flex flex-wrap gap-1.5">
                  {watchers.map((w) => (
                    <Badge key={w.id} variant="neutral">
                      {w.linearUserId}
                    </Badge>
                  ))}
                </div>
              </RailSection>
            ) : null}
          </div>
        </aside>
      </div>
    </Page>
  );
}

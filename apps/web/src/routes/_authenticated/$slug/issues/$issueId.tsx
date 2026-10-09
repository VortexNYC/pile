import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import {
  ArrowSquareOut,
  File,
  FileText,
  Link as LinkIcon,
  PencilSimple,
  Robot,
  Trash,
  Users,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { IssueComments } from "@/components/comments";
import { Markdown } from "@/components/markdown";
import { IssueForm, type IssueFormValues } from "@/components/issue-form";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useTeams } from "@/hooks/use-teams";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import {
  derivedStatusVariant,
  formatRelative,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  PRIORITY_LABELS,
  priorityVariant,
  sessionStatusVariant,
} from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/issues/$issueId")({
  component: IssueDetail,
});

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <LayerCard>
      <div className="border-b border-kumo-line px-4 py-3 flex items-center gap-2">
        {icon}
        <Text variant="secondary">{title}</Text>
      </div>
      <div className="px-4 py-3">{children}</div>
    </LayerCard>
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
      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-4 p-6">
          {editing ? (
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
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={issueStatusVariant(data.status)}>
                  {ISSUE_STATUS_LABELS[data.status]}
                </Badge>
                <Badge variant={priorityVariant(data.priority)}>
                  {PRIORITY_LABELS[data.priority]} priority
                </Badge>
                {team ? (
                  <Badge variant="neutral">
                    {team.key} — {team.name}
                  </Badge>
                ) : null}
                <Text variant="secondary">
                  created {formatRelative(data.createdAt)}
                </Text>
              </div>
              {data.description ? (
                <Markdown content={data.description} />
              ) : (
                <Text variant="secondary">No description.</Text>
              )}
            </>
          )}
        </LayerCard.Primary>
      </LayerCard>

      {issueSessions.length > 0 ? (
        <Section title="Agent sessions" icon={<Robot size={16} />}>
          <Table aria-label="Agent sessions on this issue">
            <Table.Body>
              {issueSessions.map((s) => (
                <Table.Row key={s.id}>
                  <Table.Cell>
                    <Link
                      to="/$slug/sessions/$sessionId"
                      params={{ slug: workspace.slug, sessionId: s.id }}
                      className="text-kumo-link hover:underline"
                    >
                      {s.label ?? s.id.slice(0, 8)}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={sessionStatusVariant(s.status)}>
                      {s.status}
                    </Badge>
                    {derivedStatusVariant(s.derivedStatus) ? (
                      <Badge
                        variant={
                          derivedStatusVariant(s.derivedStatus) ?? "neutral"
                        }
                        className="ml-2"
                      >
                        {s.derivedStatus?.replace("_", " ")}
                      </Badge>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {formatRelative(s.updatedAt)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Section>
      ) : null}

      {docs.length > 0 ? (
        <Section title="Linked documents" icon={<FileText size={16} />}>
          <ul className="flex flex-col gap-1.5">
            {docs.map((doc) => (
              <li key={doc.id}>
                <Link
                  to="/$slug/documents/$documentId"
                  params={{ slug: workspace.slug, documentId: doc.id }}
                  className="text-kumo-link hover:underline"
                >
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {allRelations.length > 0 ? (
        <Section title="Related issues" icon={<LinkIcon size={16} />}>
          <ul className="flex flex-col gap-1.5">
            {allRelations.map((rel) => {
              const otherId =
                rel.fromIssueId === issueId ? rel.toIssueId : rel.fromIssueId;
              return (
                <li key={rel.id} className="flex items-center gap-2">
                  <Badge variant="neutral">{rel.type}</Badge>
                  <Link
                    to="/$slug/issues/$issueId"
                    params={{ slug: workspace.slug, issueId: otherId }}
                    className="text-kumo-link hover:underline"
                  >
                    View issue
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      {links.length > 0 ? (
        <Section title="External links" icon={<ArrowSquareOut size={16} />}>
          <ul className="flex flex-col gap-1.5">
            {links.map((link) => (
              <li key={link.id}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-kumo-link hover:underline"
                >
                  {link.label ?? link.url}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {files.length > 0 ? (
        <Section title="Attachments" icon={<File size={16} />}>
          <ul className="flex flex-col gap-1.5">
            {files.map((file) => (
              <li key={file.id} className="text-sm">
                {file.title ?? file.url ?? file.r2Key ?? file.id}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {watchers.length > 0 ? (
        <Section title="Subscribers" icon={<Users size={16} />}>
          <div className="flex flex-wrap gap-2">
            {watchers.map((w) => (
              <Badge key={w.id} variant="neutral">
                {w.linearUserId}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}

      <IssueComments issueId={issueId} />
    </Page>
  );
}

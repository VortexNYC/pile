import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { EntityPage, RailSection } from "@/components/entity-page";
import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  projectHealthVariant,
  projectStatusVariant,
} from "@/lib/labels";

export const Route = createFileRoute(
  "/_authenticated/$slug/projects/$projectId"
)({
  component: ProjectDetail,
});

function ProjectDetail() {
  const { projectId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const path = { organizationId, projectId };

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
  const project = projects.data?.find((p) => p.id === projectId);

  const milestones = useQuery({
    queryKey: wsKey(organizationId, "projects", projectId, "milestones"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/projects/{projectId}/milestones",
            { params: { path } }
          )
        )
      ).milestones,
    enabled: !!project,
    retry: false,
  });

  const updates = useQuery({
    queryKey: wsKey(organizationId, "projects", projectId, "updates"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/projects/{projectId}/updates", {
            params: { path },
          })
        )
      ).updates,
    enabled: !!project,
    retry: false,
  });

  const issues = useQuery({
    queryKey: wsKey(organizationId, "issues", "project", projectId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId },
              query: { projectId },
            },
          })
        )
      ).issues,
  });

  if (projects.isPending) return <LoadingState label="Loading project" />;
  if (projects.isError || !project) {
    return (
      <Page title="Project">
        <ErrorState
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      </Page>
    );
  }
  const data = project;
  const projectIssues = issues.data ?? [];

  return (
    <EntityPage
      title={data.name}
      description={
        <>
          <Link
            to="/$slug/projects"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Projects
          </Link>
          {" · updated "}
          {formatRelative(data.updatedAt)}
        </>
      }
      center={
        <>
          <LayerCard>
            <LayerCard.Primary className="flex flex-col gap-4 p-6">
              {data.description ? (
                <Markdown
                  workspaceSlug={workspace.slug}
                  content={data.description}
                />
              ) : (
                <Text variant="secondary">No description.</Text>
              )}
            </LayerCard.Primary>
          </LayerCard>

          {projectIssues.length > 0 ? (
            <LayerCard className="p-0">
              <div className="border-b border-kumo-line px-4 py-3">
                <Text variant="secondary">Issues</Text>
              </div>
              <Table aria-label="Issues in this project">
                <Table.Body>
                  {projectIssues.map((issue) => (
                    <Table.Row key={issue.id}>
                      <Table.Cell>
                        <Link
                          to="/$slug/issues/$issueId"
                          params={{ slug: workspace.slug, issueId: issue.id }}
                          className="text-kumo-link hover:underline"
                        >
                          {issue.identifier ? (
                            <span className="text-kumo-subtle mr-2">
                              {issue.identifier}
                            </span>
                          ) : null}
                          {issue.title}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge variant={issueStatusVariant(issue.status)}>
                          {ISSUE_STATUS_LABELS[issue.status]}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="text-kumo-subtle text-sm">
                        {formatRelative(issue.updatedAt)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </LayerCard>
          ) : null}

          {(milestones.data?.length ?? 0) > 0 ? (
            <LayerCard>
              <div className="border-b border-kumo-line px-4 py-3">
                <Text variant="secondary">Milestones</Text>
              </div>
              <ul className="px-4 py-3 flex flex-col gap-1.5">
                {milestones.data?.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-sm">
                    <span>{m.name}</span>
                    <span className="text-xs text-kumo-subtle">
                      {m.targetDate?.slice(0, 10) ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            </LayerCard>
          ) : null}

          {(updates.data?.length ?? 0) > 0 ? (
            <LayerCard>
              <div className="border-b border-kumo-line px-4 py-3">
                <Text variant="secondary">Updates</Text>
              </div>
              <div className="px-4 py-3 flex flex-col gap-3">
                {updates.data?.map((u) => (
                  <div key={u.id} className="flex flex-col gap-1">
                    <Text variant="secondary" size="sm">
                      {formatRelative(u.createdAt)}
                    </Text>
                    {u.content ? (
                      <Markdown
                        workspaceSlug={workspace.slug}
                        content={u.content}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </LayerCard>
          ) : null}
        </>
      }
      rail={
        <RailSection title="Properties">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={projectStatusVariant(data.status)}>
              {data.status}
            </Badge>
            <Badge variant={projectHealthVariant(data.health)}>
              {data.health.replace("_", " ")}
            </Badge>
          </div>
          {data.startDate ? (
            <div className="text-sm text-kumo-subtle">
              {data.startDate.slice(0, 10)} →{" "}
              {data.endDate?.slice(0, 10) ?? "—"}
            </div>
          ) : null}
        </RailSection>
      }
    />
  );
}

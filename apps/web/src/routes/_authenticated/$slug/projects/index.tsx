import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  projectHealthVariant,
  projectStatusVariant,
} from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/projects/")({
  component: Projects,
});

function Projects() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;

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

  if (projects.isPending) return <LoadingState label="Loading projects" />;
  if (projects.isError) {
    return (
      <Page title="Projects">
        <ErrorState
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      </Page>
    );
  }

  const rows = (projects.data ?? []).filter((p) => !p.archivedAt);

  return (
    <Page title="Projects" description="Active projects across the workspace.">
      {rows.length === 0 ? (
        <EmptyState title="No projects" description="Nothing planned yet." />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Projects">
            <Table.Header>
              <Table.Row>
                <Table.Head>Project</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Health</Table.Head>
                <Table.Head>Dates</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((project) => (
                <Table.Row key={project.id}>
                  <Table.Cell>
                    <Link
                      to="/$slug/projects/$projectId"
                      params={{
                        slug: workspace.slug,
                        projectId: project.id,
                      }}
                      className="text-kumo-link hover:underline"
                    >
                      {project.name}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={projectStatusVariant(project.status)}>
                      {project.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={projectHealthVariant(project.health)}>
                      {project.health.replace("_", " ")}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {project.startDate
                      ? `${project.startDate.slice(0, 10)} → ${project.endDate?.slice(0, 10) ?? "—"}`
                      : "—"}
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {formatRelative(project.updatedAt)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

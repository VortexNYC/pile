import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  projectHealthVariant,
  projectStatusVariant,
} from "@/lib/labels";

/** Projects table — reused by the projects route and the Issues tab. */
export function ProjectsList() {
  const workspace = useWorkspace();
  const projects = useQuery({
    queryKey: wsKey(workspace.id, "projects"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/projects", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).projects,
  });

  if (projects.isPending) return <LoadingState label="Loading projects" />;
  if (projects.isError) {
    return (
      <ErrorState
        error={projects.error}
        onRetry={() => void projects.refetch()}
      />
    );
  }

  const rows = (projects.data ?? []).filter((p) => !p.archivedAt);
  if (rows.length === 0) {
    return (
      <EmptyState title="No projects" description="Nothing planned yet." />
    );
  }

  return (
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
  );
}

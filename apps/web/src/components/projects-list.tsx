import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useQuery } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { FieldMenu } from "@/components/field-menu";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  formatRelative,
  projectHealthVariant,
  projectStatusVariant,
} from "@/lib/labels";

/** Projects table — reused by the projects route and the Issues tab. */
const HEALTH_LABELS: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  paused: "Paused",
};
const STATUS_LABELS: Record<string, string> = {
  planned: "Planned",
  started: "Started",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
};

export function ProjectsList() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (args: { id: string; body: Record<string, string> }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/projects/{id}", {
          params: { path: { organizationId: workspace.id, id: args.id } },
          body: args.body as never,
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "projects"),
      }),
  });
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
                <FieldMenu
                  title="Status"
                  options={Object.keys(STATUS_LABELS)}
                  labels={STATUS_LABELS}
                  onSelect={(v) =>
                    patch.mutate({ id: project.id, body: { status: v } })
                  }
                >
                  <button type="button" className="cursor-pointer">
                    <Badge variant={projectStatusVariant(project.status)}>
                      {project.status}
                    </Badge>
                  </button>
                </FieldMenu>
              </Table.Cell>
              <Table.Cell>
                <FieldMenu
                  title="Health"
                  options={Object.keys(HEALTH_LABELS)}
                  labels={HEALTH_LABELS}
                  onSelect={(v) =>
                    patch.mutate({ id: project.id, body: { health: v } })
                  }
                >
                  <button type="button" className="cursor-pointer">
                    <Badge variant={projectHealthVariant(project.health)}>
                      {project.health.replace("_", " ")}
                    </Badge>
                  </button>
                </FieldMenu>
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

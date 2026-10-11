import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { ProjectsList } from "@/components/projects-list";

export const Route = createFileRoute("/_authenticated/$slug/projects/")({
  component: Projects,
});

function Projects() {
  return (
    <Page title="Projects" description="Active projects across the workspace.">
      <ProjectsList />
    </Page>
  );
}

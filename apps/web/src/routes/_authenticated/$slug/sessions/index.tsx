import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { SessionsList } from "@/components/sessions-list";

export const Route = createFileRoute("/_authenticated/$slug/sessions/")({
  component: Sessions,
});

function Sessions() {
  return (
    <Page title="Sessions" description="Agent sessions across the workspace.">
      <SessionsList />
    </Page>
  );
}

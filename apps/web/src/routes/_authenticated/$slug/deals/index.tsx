import { createFileRoute } from "@tanstack/react-router";

import { DealsList } from "@/components/deals-list";
import { Page } from "@/components/page";

export const Route = createFileRoute("/_authenticated/$slug/deals/")({
  component: Deals,
});

function Deals() {
  return (
    <Page title="Deals" description="Opportunities across the workspace.">
      <DealsList />
    </Page>
  );
}

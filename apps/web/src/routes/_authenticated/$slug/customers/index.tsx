import { createFileRoute } from "@tanstack/react-router";

import { CustomersList } from "@/components/customers-list";
import { Page } from "@/components/page";

export const Route = createFileRoute("/_authenticated/$slug/customers/")({
  component: Customers,
});

function Customers() {
  return (
    <Page title="Customers" description="Companies you work with.">
      <CustomersList />
    </Page>
  );
}

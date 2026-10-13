import { Tabs } from "@cloudflare/kumo/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ContactsList } from "@/components/contacts-list";
import { CustomersList } from "@/components/customers-list";
import { DealsList } from "@/components/deals-list";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace } from "@/hooks/use-workspace";

const TABS = [
  ["deals", "Pipeline", "deal"],
  ["customers", "Customers", "customer"],
  ["contacts", "Contacts", "contact"],
] as const;
type SalesTab = (typeof TABS)[number][0];

function isSalesTab(value: unknown): value is SalesTab {
  return TABS.some(([t]) => t === value);
}

export const Route = createFileRoute("/_authenticated/$slug/sales/")({
  component: Sales,
  validateSearch: (search: Record<string, unknown>): { tab?: SalesTab } => ({
    tab: isSalesTab(search.tab) ? search.tab : undefined,
  }),
});

/** Attio-style CRM home — one surface for the pipeline, the companies
 * behind it, and the people attached to them. */
function Sales() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const visible = TABS.filter(([, , res]) => permissions.can(res, "view"));
  const active = visible.some(([t]) => t === tab) ? tab : visible[0]?.[0];

  if (active === undefined) {
    return (
      <Page title="Sales">
        <EmptyState
          title="No sales surfaces"
          description="Your role can't view deals, customers, or contacts."
        />
      </Page>
    );
  }

  return (
    <Page title="Sales" description="Pipeline, customers, and contacts.">
      <div className="flex flex-col gap-4">
        <div>
          <Tabs
            tabs={visible.map(([value, label]) => ({ value, label }))}
            value={active}
            onValueChange={(v) =>
              void navigate({
                search: { tab: isSalesTab(v) ? v : undefined },
                replace: true,
              })
            }
          />
        </div>
        {active === "deals" ? (
          <DealsList />
        ) : active === "customers" ? (
          <CustomersList />
        ) : (
          <ContactsList />
        )}
      </div>
    </Page>
  );
}

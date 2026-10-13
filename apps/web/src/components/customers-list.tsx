import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Buildings, Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { CompanyLogo } from "@/components/company-logo";
import { EntityHover } from "@/components/entity-hover";
import { PeekHeader, usePeek } from "@/components/entity-peek";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

/** Company list + inline add — reused by the Sales tab and
 * the Support tab. */
export function CustomersList() {
  const workspace = useWorkspace();
  const peek = usePeek<NonNullable<typeof customers.data>[number]>();
  const key = wsKey(workspace.id, "customers");

  const customers = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus />}
          onClick={() =>
            window.dispatchEvent(new CustomEvent("pile:create-customer"))
          }
        >
          Add company
        </Button>
      </div>
      {customers.isPending ? (
        <LoadingState label="Loading companies" />
      ) : customers.isError ? (
        <ErrorState
          error={customers.error}
          onRetry={() => void customers.refetch()}
        />
      ) : customers.data.length === 0 ? (
        <EmptyState
          icon={<Buildings size={40} />}
          title="No companies yet"
          description="Add the companies you work with."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Companies">
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>Website</Table.Head>
                <Table.Head>Added</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {customers.data.map((customer) => (
                <Table.Row key={customer.id}>
                  <Table.Cell>
                    <EntityHover
                      title={customer.name}
                      description={customer.url}
                    >
                      <Link
                        to="/$slug/customers/$customerId"
                        params={{
                          slug: workspace.slug,
                          customerId: customer.id,
                        }}
                        onClick={peek.peekOnClick(customer)}
                        className="text-kumo-link hover:underline"
                      >
                        <span className="flex items-center gap-2">
                          <CompanyLogo
                            name={customer.name}
                            logoUrl={customer.logoUrl}
                            url={customer.url}
                          />
                          {customer.name}
                        </span>
                      </Link>
                    </EntityHover>
                  </Table.Cell>
                  <Table.Cell>{customer.url ?? "—"}</Table.Cell>
                  <Table.Cell>{formatRelative(customer.createdAt)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
      <peek.Drawer>
        {peek.peeked ? (
          <>
            <PeekHeader
              title={peek.peeked.name}
              href={`/${workspace.slug}/customers/${peek.peeked.id}`}
            />
            <div className="mt-4 flex flex-col gap-2 text-sm text-kumo-subtle">
              {peek.peeked.url ? <div>{peek.peeked.url}</div> : null}
              <div>Added {formatRelative(peek.peeked.createdAt)}</div>
            </div>
          </>
        ) : null}
      </peek.Drawer>
    </div>
  );
}

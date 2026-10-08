import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Buildings, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/customers/")({
  component: CustomersList,
});

function CustomersList() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
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

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/customers", {
          params: { path: { organizationId: workspace.id } },
          body: { name: name.trim(), url: url.trim() || undefined },
        })
      ),
    onSuccess: () => {
      setName("");
      setUrl("");
      setAdding(false);
      toastSuccess("Customer added");
    },
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <Page
      title="Customers"
      description="Companies you work with."
      actions={
        adding ? null : (
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setAdding(true)}
          >
            Add customer
          </Button>
        )
      }
    >
      {adding ? (
        <LayerCard>
          <LayerCard.Primary className="p-6">
            <form
              aria-label="Add customer"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim() && !create.isPending) create.mutate();
              }}
            >
              <Input
                label="Company name"
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label="Website"
                type="url"
                placeholder="https://example.com"
                value={url}
                required={false}
                onChange={(e) => setUrl(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={create.isPending}
                  disabled={!name.trim()}
                >
                  Save customer
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </LayerCard.Primary>
        </LayerCard>
      ) : null}
      {customers.isPending ? (
        <LoadingState label="Loading customers" />
      ) : customers.isError ? (
        <ErrorState
          error={customers.error}
          onRetry={() => void customers.refetch()}
        />
      ) : customers.data.length === 0 ? (
        <EmptyState
          icon={<Buildings size={40} />}
          title="No customers yet"
          description="Add the companies you work with."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Customers">
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
                    <Link
                      to="/$slug/customers/$customerId"
                      params={{ slug: workspace.slug, customerId: customer.id }}
                      className="text-kumo-link hover:underline"
                    >
                      {customer.name}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>{customer.url ?? "—"}</Table.Cell>
                  <Table.Cell>{formatRelative(customer.createdAt)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

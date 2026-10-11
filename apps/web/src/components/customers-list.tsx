import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Buildings, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

/** Customer list + inline add — reused by the customers route and
 * the Support tab. */
export function CustomersList() {
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
    <div className="flex flex-col gap-4">
      {!adding ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus />}
            onClick={() => setAdding(true)}
          >
            Add customer
          </Button>
        </div>
      ) : (
        <LayerCard>
          <LayerCard.Primary className="p-4">
            <form
              aria-label="Add customer"
              className="flex items-end gap-3"
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
                  Save
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
      )}
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
    </div>
  );
}

import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute(
  "/_authenticated/$slug/customers/$customerId"
)({
  component: CustomerDetail,
});

function CustomerDetail() {
  const { customerId } = Route.useParams();
  const workspace = useWorkspace();
  const key = wsKey(workspace.id, "customers", customerId);
  const path = { organizationId: workspace.id, id: customerId };
  const customer = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/customers/{id}", {
          params: { path },
        })
      ),
  });

  if (customer.isPending) return <LoadingState label="Loading customer" />;
  if (customer.isError) {
    return (
      <Page title="Customer">
        <ErrorState
          error={customer.error}
          onRetry={() => void customer.refetch()}
        />
      </Page>
    );
  }
  return (
    <CustomerEditor key={customer.data.updatedAt} customer={customer.data} />
  );
}

function CustomerEditor({
  customer,
}: {
  customer: { id: string; name: string; url: string | null };
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(customer.name);
  const [url, setUrl] = useState(customer.url ?? "");
  const listKey = wsKey(workspace.id, "customers");
  const path = { organizationId: workspace.id, id: customer.id };

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/customers/{id}", {
          params: { path },
          body: {
            name: name.trim(),
            url: url.trim() || null,
          },
        })
      ),
    onSuccess: () => toastSuccess("Customer saved"),
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/customers/{id}", {
          params: { path },
        })
      ),
    onSuccess: async () => {
      queryClient.removeQueries({
        queryKey: wsKey(workspace.id, "customers", customer.id),
      });
      await queryClient.invalidateQueries({ queryKey: listKey });
      toastSuccess("Customer deleted");
      await navigate({
        to: "/$slug/customers",
        params: { slug: workspace.slug },
      });
    },
    onError: (error) => toastError(error),
  });

  return (
    <Page
      title={customer.name}
      description={
        <Link
          to="/$slug/customers"
          params={{ slug: workspace.slug }}
          className="text-kumo-link"
        >
          Customers
        </Link>
      }
      actions={
        <Button
          variant="secondary-destructive"
          icon={<Trash />}
          loading={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete ${customer.name}?`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      }
    >
      <LayerCard>
        <LayerCard.Primary className="p-6">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !save.isPending) save.mutate();
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
              value={url}
              required={false}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div>
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={!name.trim()}
              >
                Save changes
              </Button>
            </div>
          </form>
        </LayerCard.Primary>
      </LayerCard>
    </Page>
  );
}

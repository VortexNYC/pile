import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { EntityPage, RailSection } from "@/components/entity-page";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
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
  customer: {
    id: string;
    name: string;
    url: string | null;
    bookingUrl: string | null;
  };
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tickets = useQuery({
    queryKey: wsKey(workspace.id, "customer-tickets", customer.id),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId: workspace.id },
              query: { customerId: customer.id, limit: 50 },
            },
          })
        )
      ).tickets,
  });
  const [name, setName] = useState(customer.name);
  const [url, setUrl] = useState(customer.url ?? "");
  const [bookingUrl, setBookingUrl] = useState(customer.bookingUrl ?? "");
  const listKey = wsKey(workspace.id, "customers");
  const path = { organizationId: workspace.id, id: customer.id };

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/customers/{id}", {
          params: { path },
          body: {
            name: name.trim(),
            url: url.trim() || undefined,
            bookingUrl: bookingUrl.trim() || undefined,
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
    <EntityPage
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
      center={
        <>
          {(tickets.data?.length ?? 0) > 0 ? (
            <LayerCard className="mb-4 p-0">
              <div className="border-b border-kumo-line px-4 py-3">
                <span className="text-sm font-medium text-kumo-default">
                  Tickets from {customer.name}
                </span>
              </div>
              <ul className="divide-y divide-kumo-line">
                {tickets.data?.map((ticket) => (
                  <li key={ticket.id}>
                    <Link
                      to="/$slug/tickets/$ticketId"
                      params={{
                        slug: workspace.slug,
                        ticketId: ticket.id,
                      }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-kumo-tint"
                    >
                      <span className="w-14 shrink-0 text-xs font-medium text-kumo-subtle">
                        #{ticket.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">
                        {ticket.title}
                      </span>
                      <Badge variant="secondary">{ticket.status}</Badge>
                      <span className="text-xs text-kumo-subtle">
                        {formatRelative(ticket.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </LayerCard>
          ) : null}
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
        </>
      }
      rail={
        <>
          <RailSection title="Contact">
            <div className="flex flex-col gap-1.5 text-sm">
              {customer.bookingUrl ? (
                <a
                  href={customer.bookingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-kumo-link hover:underline font-medium"
                >
                  Book a call →
                </a>
              ) : null}
              {customer.url ? (
                <a
                  href={customer.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-kumo-link hover:underline"
                >
                  {customer.url.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                <span className="text-kumo-subtle">No website</span>
              )}
            </div>
          </RailSection>
        </>
      }
    />
  );
}

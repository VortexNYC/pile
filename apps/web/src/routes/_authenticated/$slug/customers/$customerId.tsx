import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { CompanyLogo } from "@/components/company-logo";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityLinksRail } from "@/components/entity-links";
import { EntityPage, RailLink, RailSection } from "@/components/entity-page";
import { Page } from "@/components/page";
import { RecordNotes } from "@/components/record-notes";
import { ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

const OWNER_OPTIONS = [
  { id: "", label: "Unassigned" },
  {
    id: "0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE",
    label: "Shlomo (Admin / Tech & Partners)",
  },
  {
    id: "ecH8c2QyUL9IldR7F59YLtvG58s76UIh",
    label: "Ronny (Trades & Field SMBs)",
  },
] as const;

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
      <Page title="Company">
        <ErrorState
          error={customer.error}
          onRetry={() => void customer.refetch()}
        />
      </Page>
    );
  }
  return (
    <CustomerEditor
      key={customer.data.updatedAt}
      customer={customer.data as Record<string, unknown> & typeof customer.data}
    />
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
    notes: string | null;
    logoUrl: string | null;
    domain?: string | null;
    address?: string | null;
    phone?: string | null;
    vertical?: string | null;
    neighborhood?: string | null;
    ownerId?: string | null;
    signal?: string | null;
    evidenceUri?: string | null;
    priorityScore?: number | null;
    fitScore?: number | null;
    fitStatus?: string | null;
    processor?: string | null;
  };
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const leadContacts = useQuery({
    queryKey: wsKey(workspace.id, "customer-lead-contacts", customer.id),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers/{id}/contacts", {
            params: {
              path: { organizationId: workspace.id, id: customer.id },
            },
          })
        )
      ).contacts,
  });

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

  const deals = useQuery({
    queryKey: wsKey(workspace.id, "customers", customer.id, "deals"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/deals", {
            params: {
              path: { organizationId: workspace.id },
              query: { customerId: customer.id },
            },
          })
        )
      ).deals,
  });

  const [name, setName] = useState(customer.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const permissions = usePermissions(workspace.id);
  const canDelete = permissions.can("customer", "delete");
  const canEdit = permissions.can("customer", "edit");
  const [url, setUrl] = useState(customer.url ?? "");
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [address, setAddress] = useState(customer.address ?? "");
  const [vertical, setVertical] = useState(customer.vertical ?? "");
  const [ownerId, setOwnerId] = useState(customer.ownerId ?? "");
  const [bookingUrl, setBookingUrl] = useState(customer.bookingUrl ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/customers/{id}", {
          params: {
            path: { organizationId: workspace.id, id: customer.id },
          },
          body: {
            name: name.trim(),
            url: url.trim() || null,
            phone: phone.trim() || undefined,
            address: address.trim() || undefined,
            vertical: vertical.trim() || undefined,
            ownerId: ownerId || undefined,
            bookingUrl: bookingUrl.trim() || null,
            notes: notes.trim() || null,
          },
        })
      ),
    onSuccess: () => {
      toastSuccess("Saved");
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "customers"),
      });
    },
    onError: (err) => toastError(err, "Could not save company"),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/customers/{id}", {
          params: {
            path: { organizationId: workspace.id, id: customer.id },
          },
        })
      ),
    onSuccess: () => {
      toastSuccess("Company deleted");
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "customers"),
      });
      void navigate({
        to: "/$slug/sales",
        params: { slug: workspace.slug },
        search: { tab: "companies" },
      });
    },
    onError: (err) => toastError(err, "Could not delete company"),
  });

  const contactsList = leadContacts.data ?? [];
  const mapsUrl = customer.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customer.address)}`
    : null;

  return (
    <>
      <EntityPage
        title={
          <span className="flex items-center gap-2.5">
            <CompanyLogo
              name={customer.name}
              logoUrl={customer.logoUrl}
              url={customer.url}
              size={24}
            />
            {customer.name}
          </span>
        }
        description={
          <Link
            to="/$slug/sales"
            params={{ slug: workspace.slug }}
            search={{ tab: "companies" }}
            className="text-kumo-link"
          >
            Sales / Customers
          </Link>
        }
        actions={
          canDelete ? (
            <Button
              variant="secondary-destructive"
              icon={<Trash />}
              loading={remove.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          ) : undefined
        }
        center={
          <>
            {/* Verified Owner Contacts & Lead Intelligence Card */}
            <LayerCard className="mb-4 p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-kumo-default">
                    Lead Intelligence & Principal Contacts
                  </span>
                  {customer.vertical && (
                    <Badge variant="secondary">{customer.vertical}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {customer.fitScore != null && (
                    <Badge
                      variant={
                        customer.fitStatus === "great" ? "primary" : "secondary"
                      }
                    >
                      Fit {customer.fitScore} ({customer.fitStatus ?? "rated"})
                    </Badge>
                  )}
                  {customer.priorityScore != null && (
                    <Badge variant="secondary">
                      Priority P{customer.priorityScore}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 p-4 text-xs md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-kumo-subtle uppercase tracking-wider text-[11px]">
                    Phone & Location
                  </span>
                  <div className="font-mono text-sm">
                    {customer.phone ? (
                      <a
                        href={`tel:${customer.phone}`}
                        className="text-kumo-link hover:underline"
                      >
                        {customer.phone}
                      </a>
                    ) : (
                      <span className="text-kumo-subtle">No phone</span>
                    )}
                  </div>
                  <div className="text-kumo-default">
                    {customer.address ?? "No street address"}
                    {mapsUrl && (
                      <>
                        {" · "}
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-kumo-link hover:underline"
                        >
                          Google Maps ↗
                        </a>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-kumo-subtle uppercase tracking-wider text-[11px]">
                    Why Now & License Provenance
                  </span>
                  <div className="text-kumo-default">
                    {customer.signal ?? "No signal recorded yet"}
                  </div>
                  {customer.evidenceUri && (
                    <a
                      href={customer.evidenceUri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-kumo-link hover:underline truncate"
                    >
                      Official Registry Record ↗
                    </a>
                  )}
                </div>
              </div>

              {contactsList.length > 0 && (
                <div className="border-t border-kumo-line px-4 py-3">
                  <div className="mb-2 text-[11px] uppercase tracking-wider text-kumo-subtle">
                    Verified Contacts ({contactsList.length})
                  </div>
                  <div className="divide-y divide-kumo-line rounded border border-kumo-line">
                    {contactsList.map((ct) => (
                      <div
                        key={ct.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-kumo-default">
                            {ct.label ?? customer.name}
                          </span>
                          {ct.role && (
                            <Badge variant="primary">{ct.role}</Badge>
                          )}
                          <Badge variant="secondary">{ct.channel}</Badge>
                        </div>
                        <div className="flex items-center gap-2 font-mono">
                          {ct.channel === "email" ? (
                            <a
                              href={`mailto:${ct.value}`}
                              className="text-kumo-link hover:underline"
                            >
                              {ct.value}
                            </a>
                          ) : ct.channel === "phone" ? (
                            <a
                              href={`tel:${ct.value}`}
                              className="text-kumo-link hover:underline"
                            >
                              {ct.value}
                            </a>
                          ) : (
                            <span>{ct.value}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(ct.value);
                              toastSuccess(`Copied ${ct.value}`);
                            }}
                            className="rounded border border-kumo-line px-1.5 py-0.5 text-[11px] text-kumo-subtle hover:text-kumo-default"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </LayerCard>

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
                    if (!canEdit) return;
                    if (name.trim() && !save.isPending) save.mutate();
                  }}
                >
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Input
                      label="Company name"
                      value={name}
                      required
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Input
                      label="Category / Vertical"
                      value={vertical}
                      required={false}
                      onChange={(e) => setVertical(e.target.value)}
                    />
                    <Input
                      label="Phone"
                      value={phone}
                      required={false}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                    <Input
                      label="Street Address"
                      value={address}
                      required={false}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                    <Input
                      label="Website"
                      type="url"
                      value={url}
                      required={false}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-kumo-default">
                        Assigned Owner
                      </label>
                      <select
                        value={ownerId}
                        onChange={(e) => setOwnerId(e.target.value)}
                        className="h-9 rounded border border-kumo-line bg-kumo-base px-2.5 text-sm text-kumo-default"
                      >
                        {OWNER_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <Input
                    label="Booking link"
                    type="url"
                    placeholder="https://cal.com/…"
                    value={bookingUrl}
                    required={false}
                    onChange={(e) => setBookingUrl(e.target.value)}
                  />
                  <Input
                    label="Notes"
                    placeholder="Context on this account"
                    value={notes}
                    required={false}
                    onChange={(e) => setNotes(e.target.value)}
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
            <RecordNotes entityType="customer" entityId={customer.id} />
          </>
        }
        rail={
          <>
            <RailSection title="Properties">
              <div className="flex flex-col gap-1.5 text-sm">
                {customer.phone && (
                  <a
                    href={`tel:${customer.phone}`}
                    className="text-kumo-link hover:underline font-mono text-xs"
                  >
                    {customer.phone}
                  </a>
                )}
                {customer.address && (
                  <span className="text-xs text-kumo-subtle">
                    {customer.address}
                  </span>
                )}
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
                  <span className="text-kumo-subtle text-xs">No website</span>
                )}
                {customer.notes ? (
                  <p className="text-xs text-kumo-subtle whitespace-pre-wrap border-t border-kumo-line pt-2">
                    {customer.notes}
                  </p>
                ) : null}
              </div>
            </RailSection>

            <RailSection title="Relations">
              {(deals.data?.length ?? 0) > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-kumo-subtle">Deals</span>
                  {deals.data!.map((deal) => (
                    <div key={deal.id} className="flex items-center gap-2">
                      <Badge
                        variant={
                          deal.stage === "won"
                            ? "green"
                            : deal.stage === "lost"
                              ? "neutral"
                              : "blue"
                        }
                      >
                        {deal.stage}
                      </Badge>
                      <RailLink
                        to="/$slug/deals/$dealId"
                        params={{
                          slug: workspace.slug,
                          dealId: deal.id,
                        }}
                      >
                        {deal.name}
                      </RailLink>
                    </div>
                  ))}
                </div>
              ) : null}
              <EntityLinksRail entityType="customer" entityId={customer.id} />
            </RailSection>
          </>
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${customer.name}?`}
        description="Their tickets and links stay; the customer record is removed."
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
      />
    </>
  );
}

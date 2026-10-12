import { Badge } from "@cloudflare/kumo/components/badge";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { EntityHover } from "@/components/entity-hover";
import { EntityLinksRail } from "@/components/entity-links";
import { EntityPage, RailLink, RailSection } from "@/components/entity-page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative, TICKET_STATUS_LABELS } from "@/lib/labels";

export const Route = createFileRoute(
  "/_authenticated/$slug/contacts/$contactId"
)({
  component: ContactDetail,
});

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

/** A contact's page — the person: their comms ledger, their deals,
 * their tickets. The CRM is people. */
function ContactDetail() {
  const { contactId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;

  const contact = useQuery({
    queryKey: wsKey(organizationId, "contacts", contactId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/support/customers/{customerId}",
            {
              params: { path: { organizationId, customerId: contactId } },
            }
          )
        )
      ).customer,
  });

  const events = useQuery({
    queryKey: wsKey(organizationId, "contacts", contactId, "events"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/support/customers/{customerId}/events",
            {
              params: {
                path: { organizationId, customerId: contactId },
                query: {},
              },
            }
          )
        )
      ).events,
  });

  const deals = useQuery({
    queryKey: wsKey(organizationId, "deals", { contactId }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/deals", {
            params: {
              path: { organizationId },
              query: { contactId },
            },
          })
        )
      ).deals,
  });

  const tickets = useQuery({
    queryKey: wsKey(organizationId, "tickets", { contactId }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId },
              query: { customerId: contactId },
            },
          })
        )
      ).tickets,
  });

  if (contact.isPending) return <LoadingState label="Loading contact" />;
  if (contact.isError || !contact.data) {
    return (
      <ErrorState
        error={contact.error ?? new Error("Contact not found")}
        onRetry={() => void contact.refetch()}
      />
    );
  }
  const c = contact.data;

  return (
    <EntityPage
      title={c.fullName ?? c.email}
      description={
        <>
          <Link
            to="/$slug/tickets"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Contacts
          </Link>
          {" · added "}
          {formatRelative(c.createdAt)}
        </>
      }
      center={
        <div className="flex flex-col gap-4">
          {(events.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-kumo-subtle">No activity yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {events.data!.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-3 rounded-md border border-kumo-line px-3 py-2"
                >
                  <Badge variant="neutral">{event.type}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-kumo-default">{event.summary}</p>
                    <p className="text-xs text-kumo-subtle">
                      {event.source} · {formatRelative(event.occurredAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      }
      rail={
        <>
          <RailSection title="Contact">
            <div className="flex flex-col gap-1 text-sm text-kumo-subtle">
              <span>{c.email}</span>
              {c.phone ? <span>{c.phone}</span> : null}
            </div>
          </RailSection>
          {(deals.data?.length ?? 0) > 0 ? (
            <RailSection title="Deals">
              <div className="flex flex-col gap-1.5">
                {deals.data!.map((deal) => (
                  <div key={deal.id} className="flex items-center gap-2">
                    <RailLink
                      to="/$slug/deals/$dealId"
                      params={{ slug: workspace.slug, dealId: deal.id }}
                    >
                      {deal.name}
                    </RailLink>
                    <Badge
                      variant={
                        deal.stage === "won"
                          ? "green"
                          : deal.stage === "lost"
                            ? "neutral"
                            : "blue"
                      }
                    >
                      {STAGE_LABELS[deal.stage] ?? deal.stage}
                    </Badge>
                  </div>
                ))}
              </div>
            </RailSection>
          ) : null}
          {(tickets.data?.length ?? 0) > 0 ? (
            <RailSection title="Tickets">
              <div className="flex flex-col gap-1.5">
                {tickets.data!.slice(0, 8).map((ticket) => (
                  <div key={ticket.id} className="flex items-center gap-2">
                    <RailLink
                      to="/$slug/tickets/$ticketId"
                      params={{ slug: workspace.slug, ticketId: ticket.id }}
                    >
                      #{ticket.number} {ticket.title}
                    </RailLink>
                    <Badge variant="neutral">
                      {TICKET_STATUS_LABELS[ticket.status] ?? ticket.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </RailSection>
          ) : null}
          <EntityLinksRail entityType="contact" entityId={c.id} />
        </>
      }
    />
  );
}

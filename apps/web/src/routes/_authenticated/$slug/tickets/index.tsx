import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Headset, Plus } from "@phosphor-icons/react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { CapturesGrid } from "@/components/captures-grid";
import { CustomersList } from "@/components/customers-list";
import { PeekHeader, usePeek } from "@/components/entity-peek";
import { FieldMenu } from "@/components/field-menu";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import {
  formatRelative,
  isTicketStatus,
  PRIORITIES,
  PRIORITY_LABELS,
  priorityVariant,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type TicketStatus,
} from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

const ALL = "all";

export const Route = createFileRoute("/_authenticated/$slug/tickets/")({
  component: TicketsList,
  validateSearch: (
    search: Record<string, unknown>
  ): { status?: TicketStatus; tab?: "tickets" | "customers" | "captures" } => ({
    status: isTicketStatus(search.status) ? search.status : undefined,
    tab:
      search.tab === "customers" || search.tab === "captures"
        ? search.tab
        : "tickets",
  }),
});

function TicketsList() {
  const workspace = useWorkspace();
  const { status, tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [adding, setAdding] = useState(false);
  const session = betterAuthClient.useSession();
  const [folder, setFolder] = useState<"all" | "mine" | "unassigned">("all");
  const tickets = useQuery({
    queryKey: wsKey(workspace.id, "tickets", { status }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 100, status },
            },
          })
        )
      ).tickets,
    placeholderData: keepPreviousData,
  });
  const queryClient = useQueryClient();
  const peek = usePeek<NonNullable<typeof tickets.data>[number]>();
  const patch = useMutation({
    mutationFn: (args: { id: string; body: Record<string, string> }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/support/tickets/{ticketId}", {
          params: {
            path: { organizationId: workspace.id, ticketId: args.id },
          },
          body: args.body as never,
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "tickets"),
      }),
  });

  const me = session.data?.user.id;
  const rows = (tickets.data ?? []).filter((ticket) => {
    if (folder === "unassigned") return ticket.assignees.length === 0;
    if (folder === "mine")
      return (
        me != null &&
        ticket.assignees.some((a) => a.type === "user" && a.assigneeId === me)
      );
    return true;
  });

  return (
    <Page
      title="Support"
      description="Customer conversations that need a response."
      actions={
        adding || tab !== "tickets" ? null : (
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setAdding(true)}
          >
            New ticket
          </Button>
        )
      }
    >
      <>
        {adding ? <NewTicketForm onDone={() => setAdding(false)} /> : null}
        <div className="flex items-center gap-3">
          <Tabs
            tabs={[
              { value: "all", label: "All" },
              { value: "mine", label: "Mine" },
              { value: "unassigned", label: "Unassigned" },
            ]}
            value={folder}
            onValueChange={(v) => setFolder(v as "all" | "mine" | "unassigned")}
          />
          <Select
            aria-label="Filter by status"
            value={status ?? ALL}
            onValueChange={(value) =>
              void navigate({
                search: { status: isTicketStatus(value) ? value : undefined },
                replace: true,
              })
            }
            renderValue={(v) =>
              isTicketStatus(v) ? TICKET_STATUS_LABELS[v] : "All tickets"
            }
          >
            <Select.Option value={ALL}>All tickets</Select.Option>
            {TICKET_STATUSES.map((s) => (
              <Select.Option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </Select.Option>
            ))}
          </Select>
        </div>
        {tickets.isPending ? (
          <LoadingState label="Loading tickets" />
        ) : tickets.isError ? (
          <ErrorState
            error={tickets.error}
            onRetry={() => void tickets.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Headset size={40} />}
            title="No tickets"
            description="Nothing waiting on you."
          />
        ) : (
          <LayerCard className="p-0">
            <Table aria-label="Support tickets">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Ticket</Table.Head>
                  <Table.Head>Customer</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Priority</Table.Head>
                  <Table.Head>Updated</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((ticket) => (
                  <Table.Row key={ticket.id}>
                    <Table.Cell>
                      <Link
                        to="/$slug/tickets/$ticketId"
                        params={{ slug: workspace.slug, ticketId: ticket.id }}
                        onClick={peek.peekOnClick(ticket)}
                        className="text-kumo-link hover:underline"
                      >
                        <span className="text-kumo-subtle mr-2">
                          #{ticket.number}
                        </span>
                        {ticket.title}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>
                      {ticket.customer.fullName ?? ticket.customer.email}
                    </Table.Cell>
                    <Table.Cell>
                      <FieldMenu
                        title="Status"
                        options={TICKET_STATUSES}
                        labels={TICKET_STATUS_LABELS}
                        onSelect={(v) =>
                          patch.mutate({ id: ticket.id, body: { status: v } })
                        }
                      >
                        <button type="button" className="cursor-pointer">
                          <Badge
                            variant={
                              ticket.status === "done"
                                ? "green"
                                : ticket.status === "snoozed"
                                  ? "neutral"
                                  : "blue"
                            }
                          >
                            {TICKET_STATUS_LABELS[ticket.status]}
                          </Badge>
                        </button>
                      </FieldMenu>
                    </Table.Cell>
                    <Table.Cell>
                      <FieldMenu
                        title="Priority"
                        options={PRIORITIES}
                        labels={PRIORITY_LABELS}
                        onSelect={(v) =>
                          patch.mutate({ id: ticket.id, body: { priority: v } })
                        }
                      >
                        <button type="button" className="cursor-pointer">
                          <Badge variant={priorityVariant(ticket.priority)}>
                            {PRIORITY_LABELS[ticket.priority]}
                          </Badge>
                        </button>
                      </FieldMenu>
                    </Table.Cell>
                    <Table.Cell>{formatRelative(ticket.updatedAt)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </>

      <div className="mt-8 flex flex-col gap-2 border-t border-kumo-line pt-4">
        <h2 className="text-sm font-medium text-kumo-subtle px-1">Customers</h2>
        <CustomersList />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-kumo-subtle px-1">Captures</h2>
        <CapturesGrid />
      </div>

      <peek.Drawer>
        {peek.peeked ? (
          <>
            <PeekHeader
              meta={
                <Badge
                  variant={
                    peek.peeked.status === "done"
                      ? "green"
                      : peek.peeked.status === "snoozed"
                        ? "neutral"
                        : "blue"
                  }
                >
                  {TICKET_STATUS_LABELS[peek.peeked.status]}
                </Badge>
              }
              title={`#${peek.peeked.number} ${peek.peeked.title}`}
              href={`/${workspace.slug}/tickets/${peek.peeked.id}`}
            />
            <div className="mt-4 flex flex-col gap-2 text-sm text-kumo-subtle">
              <div>
                Customer:{" "}
                {peek.peeked.customer.fullName ?? peek.peeked.customer.email}
              </div>
              <div>Updated {formatRelative(peek.peeked.updatedAt)}</div>
            </div>
          </>
        ) : null}
      </peek.Drawer>
    </Page>
  );
}

function NewTicketForm({ onDone }: { onDone: () => void }) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const organizationId = workspace.id;

  const create = useMutation({
    mutationFn: async () => {
      const contact = await unwrap(
        api.POST("/workspaces/{organizationId}/support/customers", {
          params: { path: { organizationId } },
          body: { email: email.trim(), fullName: fullName.trim() || undefined },
        })
      );
      return unwrap(
        api.POST("/workspaces/{organizationId}/support/tickets", {
          params: { path: { organizationId } },
          body: {
            customerId: contact.customer.id,
            title: title.trim(),
            sourceChannel: "api",
            externalSource: "manual",
            ...(message.trim()
              ? {
                  message: {
                    textContent: message.trim(),
                    channel: "api" as const,
                  },
                }
              : {}),
          },
        })
      );
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "tickets"),
      });
      toastSuccess("Ticket created");
      onDone();
      await navigate({
        to: "/$slug/tickets/$ticketId",
        params: { slug: workspace.slug, ticketId: result.ticket.id },
      });
    },
    onError: (error) => toastError(error),
  });

  const valid = email.trim().length > 0 && title.trim().length > 0;

  return (
    <LayerCard>
      <LayerCard.Primary className="p-6">
        <form
          aria-label="New ticket"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Customer email"
              type="email"
              value={email}
              required
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Customer name"
              value={fullName}
              required={false}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
          <Input
            label="Subject"
            value={title}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
          <InputArea
            label="What did they say?"
            value={message}
            required={false}
            minRows={3}
            autoResize
            onValueChange={setMessage}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              disabled={!valid}
            >
              Create ticket
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}

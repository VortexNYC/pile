import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Composer } from "@/components/composer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityLinksRail } from "@/components/entity-links";
import { EntityPage, RailSection } from "@/components/entity-page";
import { Feed } from "@/components/feed";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import {
  formatRelative,
  isPriority,
  isTicketStatus,
  PRIORITIES,
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type IssuePriority,
  type TicketStatus,
} from "@/lib/labels";
import { mentionTargets as mentionTargetsFor } from "@/lib/mentions";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/tickets/$ticketId")(
  {
    component: TicketDetail,
  }
);

function TicketDetail() {
  const { ticketId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();

  // Jam's trick — hand the customer a link; they record the bug, a
  // capture ticket lands back in the workspace. Reuse or mint the
  // workspace's public key, then create the link.
  const captureLink = useMutation({
    mutationFn: async () => {
      const keys = (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/capture/public-keys", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).publicKeys;
      const key =
        keys[0] ??
        (await unwrap(
          api.POST("/workspaces/{organizationId}/support/capture/public-keys", {
            params: { path: { organizationId: workspace.id } },
            body: { name: "Ticket capture links" },
          })
        ));
      return unwrap(
        api.POST("/workspaces/{organizationId}/support/capture-links", {
          params: { path: { organizationId: workspace.id } },
          body: {
            publicKeyId: key.id,
            name: `Ticket ${data.number} — send me the bug`,
          },
        })
      );
    },
    onSuccess: (link) => {
      navigator.clipboard.writeText(link.url);
      toastSuccess("Capture link copied — send it to the customer");
    },
    onError: (error) => toastError(error),
  });
  const key = wsKey(organizationId, "tickets", ticketId);
  const path = { organizationId, ticketId };
  const sharedCapture = useQuery({
    queryKey: wsKey(organizationId, "shared-capture", ticketId),
    staleTime: 60_000,
    queryFn: async () => {
      const res = await api.GET("/support/capture/public/{ticketId}", {
        params: { path: { ticketId } },
      });
      return res.response.ok;
    },
  });

  const tickets = useQuery({
    queryKey: wsKey(workspace.id, "tickets"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets", {
            params: {
              path: { organizationId: workspace.id },
              query: { limit: 100 },
            },
          })
        )
      ).tickets,
  });
  const members = useQuery({
    queryKey: wsKey(organizationId, "members"),
    queryFn: async () => {
      const res = await betterAuthClient.organization.listMembers({
        query: { organizationId },
      });
      return res.data?.members ?? [];
    },
  });
  const mentionTargets = mentionTargetsFor(members.data);

  const ticket = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/tickets/{ticketId}", {
            params: { path },
          })
        )
      ).ticket,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "tickets"),
      }),
    ]);

  const update = useMutation({
    mutationFn: (body: { status?: TicketStatus; priority?: IssuePriority }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/support/tickets/{ticketId}", {
          params: { path },
          body,
        })
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const editNote = useMutation({
    mutationFn: ({ eventId, body }: { eventId: string; body: string }) =>
      unwrap(
        api.PATCH(
          "/workspaces/{organizationId}/support/tickets/{ticketId}/notes/{eventId}",
          { params: { path: { ...path, eventId } }, body: { body } }
        )
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });
  const deleteNote = useMutation({
    mutationFn: (eventId: string) =>
      unwrap(
        api.DELETE(
          "/workspaces/{organizationId}/support/tickets/{ticketId}/notes/{eventId}",
          { params: { path: { ...path, eventId } } }
        )
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });
  const [editingNote, setEditingNote] = useState<{
    id: string;
    body: string;
  } | null>(null);
  const [deletingNote, setDeletingNote] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async (input: {
      text: string;
      mode: "reply" | "note";
      channel:
        | "email"
        | "slack"
        | "msteams"
        | "discord"
        | "chat"
        | "capture"
        | "api"
        | "intercom"
        | "zendesk"
        | "plain"
        | "linear"
        | "sms";
    }) => {
      if (input.mode === "note") {
        await unwrap(
          api.POST(
            "/workspaces/{organizationId}/support/tickets/{ticketId}/notes",
            {
              params: { path },
              body: { body: input.text },
            }
          )
        );
        return;
      }
      await unwrap(
        api.POST(
          "/workspaces/{organizationId}/support/tickets/{ticketId}/messages",
          {
            params: { path },
            body: {
              direction: "outbound",
              textContent: input.text,
              channel: input.channel,
            },
          }
        )
      );
    },
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const customerId = ticket.data?.customer.id;
  const comms = useQuery({
    queryKey: wsKey(workspace.id, "comms", { customerId }),
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/support/customers/{customerId}/events",
            {
              params: {
                path: {
                  organizationId: workspace.id,
                  customerId: customerId ?? "",
                },
                query: { limit: 5 },
              },
            }
          )
        )
      ).events,
    enabled: customerId !== undefined,
  });

  if (ticket.isPending) return <LoadingState label="Loading ticket" />;
  if (ticket.isError) {
    return (
      <Page title="Ticket">
        <ErrorState
          error={ticket.error}
          onRetry={() => void ticket.refetch()}
        />
      </Page>
    );
  }
  const data = ticket.data;
  const events = data.events.filter((e) => e.message || e.note);
  const otherTickets = (tickets.data ?? []).filter(
    (tt) => tt.customer.id === data.customer.id && tt.id !== data.id
  );

  return (
    <EntityPage
      title={`#${data.number} ${data.title}`}
      description={
        <>
          <Link
            to="/$slug/tickets"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Support
          </Link>{" "}
          · {data.customer.fullName ?? data.customer.email} · opened{" "}
          {formatRelative(data.createdAt)}
        </>
      }
      actions={
        <div className="flex items-center gap-2">
          {captureLink.data ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(captureLink.data!.url);
                toastSuccess("Capture link copied");
              }}
            >
              Send capture link
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              loading={captureLink.isPending}
              onClick={() => captureLink.mutate()}
            >
              Send capture link
            </Button>
          )}
          {sharedCapture.data === true ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(
                  `${window.location.origin}/app/share/capture/${ticketId}`
                );
                toastSuccess("Shared capture link copied");
              }}
            >
              Copy shared capture link
            </Button>
          ) : null}
        </div>
      }
      center={
        <>
          <div className="flex flex-wrap gap-4">
            <Select
              label="Status"
              value={data.status}
              disabled={update.isPending}
              onValueChange={(status) => {
                if (isTicketStatus(status) && status !== data.status)
                  update.mutate({ status });
              }}
              renderValue={(v) =>
                isTicketStatus(v) ? TICKET_STATUS_LABELS[v] : ""
              }
            >
              {TICKET_STATUSES.map((s) => (
                <Select.Option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </Select.Option>
              ))}
            </Select>
            <Select
              label="Priority"
              value={data.priority}
              disabled={update.isPending}
              onValueChange={(priority) => {
                if (isPriority(priority) && priority !== data.priority)
                  update.mutate({ priority });
              }}
              renderValue={(v) => (isPriority(v) ? PRIORITY_LABELS[v] : "")}
            >
              {PRIORITIES.map((p) => (
                <Select.Option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </Select.Option>
              ))}
            </Select>
          </div>
          <section aria-label="Conversation">
            {events.length === 0 ? (
              <Text variant="secondary" size="sm">
                No messages yet.
              </Text>
            ) : (
              <Feed>
                {events.map((event) => {
                  const isNote = !!event.note;
                  const inbound = event.message?.direction === "inbound";
                  return (
                    <Feed.Row
                      key={event.id}
                      marker={
                        <Badge
                          variant={
                            isNote ? "orange" : inbound ? "neutral" : "blue"
                          }
                        >
                          {isNote
                            ? "Internal note"
                            : inbound
                              ? "Customer"
                              : "Reply"}
                        </Badge>
                      }
                      body={
                        isNote && editingNote?.id === event.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              editNote.mutate({
                                eventId: event.id,
                                body: editingNote.body,
                              });
                              setEditingNote(null);
                            }}
                          >
                            <InputArea
                              aria-label="Edit note"
                              value={editingNote.body}
                              autoResize
                              minRows={1}
                              onValueChange={(v) =>
                                setEditingNote({ id: event.id, body: v })
                              }
                            />
                            <Button type="submit" size="xs" variant="primary">
                              Save
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => setEditingNote(null)}
                            >
                              Cancel
                            </Button>
                          </form>
                        ) : (
                          <span className="whitespace-pre-wrap">
                            {event.note?.body ?? event.message?.textContent}
                          </span>
                        )
                      }
                      timestamp={event.createdAt}
                      actions={
                        isNote ? (
                          <>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                setEditingNote({
                                  id: event.id,
                                  body: event.note?.body ?? "",
                                })
                              }
                            >
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => setDeletingNote(event.id)}
                            >
                              Delete
                            </Button>
                          </>
                        ) : undefined
                      }
                    />
                  );
                })}
              </Feed>
            )}
          </section>
          <ConfirmDialog
            open={deletingNote !== null}
            onOpenChange={(o) => !o && setDeletingNote(null)}
            title="Delete note"
            description="This can't be undone."
            loading={deleteNote.isPending}
            onConfirm={() => {
              if (deletingNote) deleteNote.mutate(deletingNote);
              setDeletingNote(null);
            }}
          />
          <Composer
            aria-label="Ticket reply"
            loading={send.isPending}
            members={mentionTargets}
            modes={[
              {
                id: "reply",
                label: "Reply to customer",
                placeholder: "Write a reply…",
                submitLabel: "Send reply",
              },
              {
                id: "note",
                label: "Internal note",
                placeholder: "Only your team sees this…",
                submitLabel: "Add note",
              },
            ]}
            onSubmit={(text, m) =>
              send.mutate({
                text,
                mode: (m as "reply" | "note") ?? "reply",
                channel: data.sourceChannel,
              })
            }
          />
        </>
      }
      rail={
        <>
          <RailSection title="Customer">
            <div>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-kumo-default">
                  {data.customer.fullName ?? "—"}
                </span>
                <span className="text-kumo-subtle">{data.customer.email}</span>
                {data.customer.phone ? (
                  <span className="text-kumo-subtle">
                    {data.customer.phone}
                  </span>
                ) : null}
              </div>
            </div>
          </RailSection>
          {otherTickets.length > 0 ? (
            <RailSection title="Other tickets from them">
              <ul className="flex flex-col gap-1">
                {otherTickets.slice(0, 5).map((tt) => (
                  <li key={tt.id}>
                    <Link
                      to="/$slug/tickets/$ticketId"
                      params={{
                        slug: workspace.slug,
                        ticketId: tt.id,
                      }}
                      className="text-sm text-kumo-link hover:underline"
                    >
                      #{tt.number} {tt.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </RailSection>
          ) : null}
          {(comms.data?.length ?? 0) > 0 ? (
            <RailSection title="Recent activity">
              <ul className="flex flex-col gap-1.5">
                {(comms.data ?? []).map((event) => (
                  <li key={event.id} className="text-sm">
                    <div className="text-kumo-default">{event.summary}</div>
                    <div className="text-xs text-kumo-subtle">
                      {event.source} · {event.occurredAt.slice(0, 10)}
                    </div>
                  </li>
                ))}
              </ul>
            </RailSection>
          ) : null}
          <EntityLinksRail entityType="ticket" entityId={data.id} />
        </>
      }
    />
  );
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
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
import { toastError } from "@/lib/toast";

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
  const [reply, setReply] = useState("");
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const key = wsKey(organizationId, "tickets", ticketId);
  const path = { organizationId, ticketId };

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

  const channels = useQuery({
    queryKey: wsKey(organizationId, "support-channels"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support-channels", {
            params: { path: { organizationId } },
          })
        )
      ).channels,
  });

  const send = useMutation({
    mutationFn: async (input: {
      text: string;
      mode: "reply" | "note";
      channelId: string | null;
    }) => {
      if (input.mode === "note" || !input.channelId) {
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
      const result = await unwrap(
        api.POST(
          "/workspaces/{organizationId}/support/channels/{channelId}/send",
          {
            params: { path: { organizationId, channelId: input.channelId } },
            body: {
              ticketId,
              textContent: input.text,
              idempotencyKey: crypto.randomUUID(),
            },
          }
        )
      );
      if (!result.sent) {
        throw new Error(
          "Your reply was saved, but it couldn't be delivered to the customer."
        );
      }
    },
    onSuccess: () => setReply(""),
    onError: (error) => toastError(error),
    onSettled: invalidate,
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
  const replyChannel =
    channels.data?.find(
      (channel) => channel.isActive && channel.type === data.sourceChannel
    ) ?? null;
  const canReply = replyChannel !== null;
  const effectiveMode = canReply ? mode : "note";
  const events = data.events.filter((e) => e.message || e.note);

  return (
    <Page
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
    >
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
      <section aria-label="Conversation" className="flex flex-col gap-3">
        {events.length === 0 ? (
          <Text variant="secondary" size="sm">
            No messages yet.
          </Text>
        ) : (
          events.map((event) => {
            const isNote = !!event.note;
            const inbound = event.message?.direction === "inbound";
            return (
              <LayerCard key={event.id} data-testid="ticket-event">
                <LayerCard.Primary className="flex flex-col gap-1 p-4">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={isNote ? "orange" : inbound ? "neutral" : "blue"}
                    >
                      {isNote
                        ? "Internal note"
                        : inbound
                          ? "Customer"
                          : "Reply"}
                    </Badge>
                    <Text variant="secondary" size="xs">
                      {formatRelative(event.createdAt)}
                    </Text>
                  </div>
                  <Text>
                    <span className="whitespace-pre-wrap">
                      {event.note?.body ?? event.message?.textContent}
                    </span>
                  </Text>
                </LayerCard.Primary>
              </LayerCard>
            );
          })
        )}
      </section>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = reply.trim();
          if (text && !send.isPending)
            send.mutate({
              text,
              mode: effectiveMode,
              channelId: replyChannel?.id ?? null,
            });
        }}
      >
        <div className="flex gap-2" role="group" aria-label="Message type">
          <Button
            type="button"
            size="sm"
            variant={effectiveMode === "reply" ? "primary" : "ghost"}
            aria-pressed={effectiveMode === "reply"}
            disabled={!canReply}
            onClick={() => setMode("reply")}
          >
            Reply to customer
          </Button>
          <Button
            type="button"
            size="sm"
            variant={effectiveMode === "note" ? "primary" : "ghost"}
            aria-pressed={effectiveMode === "note"}
            onClick={() => setMode("note")}
          >
            Internal note
          </Button>
        </div>
        {channels.isSuccess && !canReply ? (
          <Text variant="secondary" size="sm">
            This ticket came in through a channel that isn't connected for
            replies, so you can only add internal notes here.
          </Text>
        ) : null}
        <InputArea
          aria-label={effectiveMode === "note" ? "Internal note" : "Reply"}
          placeholder={
            effectiveMode === "note"
              ? "Only your team sees this…"
              : "Write a reply…"
          }
          value={reply}
          autoResize
          minRows={3}
          onValueChange={setReply}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={send.isPending}
            disabled={!reply.trim()}
          >
            {effectiveMode === "note" ? "Add note" : "Send reply"}
          </Button>
        </div>
      </form>
    </Page>
  );
}

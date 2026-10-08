import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Text } from "@cloudflare/kumo/components/text";
import { Bell } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { formatRelative, notificationLabel } from "@/lib/labels";
import { toastError } from "@/lib/toast";

const POLL_MS = 30_000;

export function NotificationsBell() {
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const params = { path: { organizationId } };

  const unread = useQuery({
    queryKey: wsKey(organizationId, "notifications", "unread-count"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/notifications/unread-count", {
            params,
          })
        )
      ).count,
    refetchInterval: POLL_MS,
  });

  const feed = useQuery({
    queryKey: wsKey(organizationId, "notifications", "feed"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/notifications", {
            params: { ...params, query: { limit: "20" } },
          })
        )
      ).notifications,
    enabled: open,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: wsKey(organizationId, "notifications"),
    });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/notifications/{id}/read", {
          params: { path: { organizationId, id } },
        })
      ),
    onSettled: invalidate,
  });

  const markAll = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.POST("/workspaces/{organizationId}/notifications/mark-all-read", {
          params,
        })
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const count = unread.data ?? 0;
  const items = feed.data ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            shape="square"
            variant="ghost"
            icon={<Bell size={18} />}
            aria-label={
              count > 0 ? `Notifications (${count} unread)` : "Notifications"
            }
          />
        }
      />
      {count > 0 ? (
        <span aria-hidden className="-ml-4 -mt-5">
          <Badge variant="red">{count > 99 ? "99+" : count}</Badge>
        </span>
      ) : null}
      <Popover.Content className="w-80">
        <div className="flex items-center justify-between gap-2 pb-2">
          <Popover.Title>Notifications</Popover.Title>
          <Button
            size="xs"
            variant="ghost"
            disabled={count === 0}
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        </div>
        {feed.isPending ? (
          <Text variant="secondary" size="sm">
            Loading…
          </Text>
        ) : feed.isError ? (
          <Text variant="error" size="sm">
            {feed.error.message}
          </Text>
        ) : items.length === 0 ? (
          <Popover.Description>You're all caught up.</Popover.Description>
        ) : (
          <ul
            className="flex max-h-96 flex-col gap-1 overflow-y-auto"
            aria-label="Notification list"
          >
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="hover:bg-kumo-tint flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left"
                  onClick={() => {
                    if (!item.read) markRead.mutate(item.id);
                    setOpen(false);
                    void navigate({
                      to: "/$slug/issues/$issueId",
                      params: { slug: workspace.slug, issueId: item.issueId },
                    });
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    {item.read ? null : (
                      <span
                        aria-label="Unread"
                        className="bg-kumo-brand size-2 shrink-0 rounded-full"
                      />
                    )}
                    <Text size="sm" bold={!item.read} truncate>
                      {notificationLabel(item.type)}
                    </Text>
                  </span>
                  <Text variant="secondary" size="xs">
                    {formatRelative(item.createdAt)}
                  </Text>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Popover.Content>
    </Popover>
  );
}

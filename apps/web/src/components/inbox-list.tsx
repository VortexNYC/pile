import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { BellRinging } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { formatRelative, notificationLabel } from "@/lib/labels";
import { toastError } from "@/lib/toast";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The inbox — same list for the /inbox route and the bell drawer. */
export function InboxList({
  organizationId,
  slug,
  onNavigate,
}: {
  organizationId: string;
  slug: string;
  onNavigate?: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"all" | "unread">("all");

  const feed = useQuery({
    queryKey: wsKey(organizationId, "notifications", "inbox"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/notifications", {
            params: {
              path: { organizationId },
              query: { limit: "100" },
            },
          })
        )
      ).notifications,
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
          params: { path: { organizationId } },
        })
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  if (feed.isPending) return <LoadingState label="Loading inbox" />;
  if (feed.isError) {
    return (
      <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
    );
  }

  const items = (feed.data ?? []).filter((item) =>
    tab === "unread" ? !item.read : true
  );
  const now = Date.now();
  const thisWeek = items.filter(
    (i) => now - new Date(i.createdAt).getTime() < WEEK_MS
  );
  const older = items.filter(
    (i) => now - new Date(i.createdAt).getTime() >= WEEK_MS
  );
  const unreadCount = (feed.data ?? []).filter((i) => !i.read).length;

  const section = (title: string, rows: typeof items) =>
    rows.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <Text variant="secondary" size="xs">
          {title}
        </Text>
        <LayerCard className="p-0">
          <ul className="divide-y divide-kumo-line">
            {rows.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="hover:bg-kumo-tint flex w-full items-center gap-3 px-4 py-3 text-left"
                  onClick={() => {
                    if (!item.read) markRead.mutate(item.id);
                    onNavigate?.();
                    void navigate({
                      to: "/$slug/issues/$issueId",
                      params: {
                        slug,
                        issueId: item.issueId,
                      },
                    });
                  }}
                >
                  {item.read ? (
                    <span className="size-2 shrink-0" />
                  ) : (
                    <span
                      aria-label="Unread"
                      className="bg-kumo-brand size-2 shrink-0 rounded-full"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <Text size="sm" bold={!item.read} truncate as="span">
                      {notificationLabel(item.type)}
                    </Text>
                  </span>
                  <span className="text-xs text-kumo-subtle shrink-0">
                    {formatRelative(item.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </LayerCard>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Tabs
          tabs={[
            { value: "all", label: "All" },
            {
              value: "unread",
              label: unreadCount > 0 ? `Unread (${unreadCount})` : "Unread",
            },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as "all" | "unread")}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={unreadCount === 0}
          loading={markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<BellRinging size={40} />}
          title="You're all caught up"
          description={
            tab === "unread"
              ? "Nothing unread — check All for the history."
              : "Assignments, mentions, and issue updates land here."
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {section("This week", thisWeek)}
          {section("Older", older)}
        </div>
      )}
    </div>
  );
}

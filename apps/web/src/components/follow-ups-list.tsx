import { Badge } from "@cloudflare/kumo/components/badge";
import { CalendarCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { ownerDisplayName } from "@/components/customers-list";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { stageColor } from "@/lib/customer-stages";
import {
  type FollowUpBuckets,
  bucketFollowUps,
  followUpDueBefore,
} from "@/lib/follow-ups";
import { formatRelative } from "@/lib/labels";

/** Section order on the Follow-ups tab — most urgent first. */
export const FOLLOW_UP_SECTIONS: ReadonlyArray<{
  key: keyof FollowUpBuckets<unknown>;
  title: string;
}> = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Due today" },
  { key: "upcoming", title: "Next 7 days" },
];

/** Sales → Follow-ups: every customer whose nextStepDueAt lands inside the
 *  next week, split overdue → today → upcoming. One `dueBefore` query feeds
 *  all three sections. */
export function FollowUpsList() {
  const workspace = useWorkspace();
  // Frozen per mount so the query key is stable across re-renders.
  const dueBefore = useMemo(() => followUpDueBefore(), []);
  const now = useMemo(() => Date.now(), []);

  const customers = useQuery({
    queryKey: wsKey(workspace.id, "customers", "followups", dueBefore),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: {
              path: { organizationId: workspace.id },
              query: { dueBefore },
            },
          })
        )
      ).customers,
    staleTime: 30_000,
  });

  const statuses = useQuery({
    queryKey: wsKey(workspace.id, "customer-statuses"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customer-statuses", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).statuses,
    staleTime: 30_000,
  });
  const statusById = useMemo(
    () => new Map((statuses.data ?? []).map((s) => [s.id, s])),
    [statuses.data]
  );

  const buckets = useMemo(
    () => bucketFollowUps(customers.data ?? [], now),
    [customers.data, now]
  );
  const total =
    buckets.overdue.length + buckets.today.length + buckets.upcoming.length;

  if (customers.isPending) return <LoadingState label="Loading follow-ups" />;
  if (customers.isError) {
    return (
      <ErrorState
        error={customers.error}
        onRetry={() => void customers.refetch()}
      />
    );
  }
  if (total === 0) {
    return (
      <EmptyState
        icon={<CalendarCheck size={40} />}
        title="Nothing due"
        description="No customer has a next step due in the next 7 days. Log a touch on the Customers tab to schedule one."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {FOLLOW_UP_SECTIONS.map(({ key, title }) => {
        const rows = buckets[key];
        if (rows.length === 0) return null;
        return (
          <section key={key} className="flex flex-col gap-1.5">
            <h3
              className={`text-xs font-semibold uppercase tracking-wider ${
                key === "overdue" ? "text-red-500" : "text-kumo-subtle"
              }`}
            >
              {title} · {rows.length}
            </h3>
            <div className="divide-y divide-kumo-line rounded border border-kumo-line bg-kumo-base">
              {rows.map((customer) => {
                const stage = customer.statusId
                  ? (statusById.get(customer.statusId) ?? null)
                  : null;
                return (
                  <div
                    key={customer.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <Link
                      to="/$slug/customers/$customerId"
                      params={{
                        slug: workspace.slug,
                        customerId: customer.id,
                      }}
                      className="min-w-0 flex-1 truncate font-medium text-kumo-link hover:underline"
                    >
                      {customer.name}
                    </Link>
                    <span className="hidden max-w-[40%] truncate text-kumo-subtle sm:inline">
                      {customer.nextStepText ?? "—"}
                    </span>
                    {stage && (
                      <Badge variant="secondary">
                        <span
                          aria-hidden
                          className="mr-1 inline-block size-1.5 rounded-full"
                          style={{ backgroundColor: stageColor(stage) }}
                        />
                        {stage.name}
                      </Badge>
                    )}
                    <span className="w-20 truncate text-xs text-kumo-subtle">
                      {ownerDisplayName(customer.ownerId)}
                    </span>
                    <span
                      className={`w-24 text-right font-mono text-xs ${
                        key === "overdue"
                          ? "font-medium text-red-500"
                          : "text-kumo-subtle"
                      }`}
                    >
                      {customer.nextStepDueAt
                        ? formatRelative(customer.nextStepDueAt, now)
                        : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

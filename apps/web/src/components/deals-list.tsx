import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Plus, TrendUp } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityHover } from "@/components/entity-hover";
import { PeekHeader, usePeek } from "@/components/entity-peek";
import { FieldMenu } from "@/components/field-menu";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

const STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currency ?? "USD",
  }).format(cents / 100);
}

/** The pipeline — deals grouped by stage, inline-editable. */
export function DealsList() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const peek = usePeek<NonNullable<typeof deals.data>[number]>();
  const customers = useQuery({
    queryKey: wsKey(workspace.id, "customers"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
  });
  const customerName = (id: string) =>
    customers.data?.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const deals = useQuery({
    queryKey: wsKey(workspace.id, "deals"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/deals", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).deals,
  });
  const patch = useMutation({
    mutationFn: (args: { id: string; body: Record<string, unknown> }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/deals/{dealId}", {
          params: { path: { organizationId: workspace.id, dealId: args.id } },
          body: args.body as never,
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals"),
      }),
  });

  if (deals.isPending) return <LoadingState label="Loading deals" />;
  if (deals.isError) {
    return (
      <ErrorState error={deals.error} onRetry={() => void deals.refetch()} />
    );
  }

  const open = (deals.data ?? []).filter((d) => !d.archivedAt);
  if (open.length === 0) {
    return (
      <EmptyState
        icon={<TrendUp size={40} />}
        title="No deals yet"
        description="Track opportunities against customers — stage, amount, and close date."
      />
    );
  }

  return (
    <>
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus />}
          onClick={() =>
            window.dispatchEvent(new CustomEvent("pile:create-deal"))
          }
        >
          New deal
        </Button>
      </div>
      <div className="flex flex-col gap-5">
        {STAGES.map((stage) => {
          const rows = open.filter((d) => d.stage === stage);
          if (rows.length === 0) return null;
          return (
            <div key={stage} className="flex flex-col">
              <div className="flex items-center gap-2 px-1 pb-1.5">
                <span className="text-xs font-medium text-kumo-subtle uppercase">
                  {STAGE_LABELS[stage]}
                </span>
                <span className="text-xs text-kumo-subtle">{rows.length}</span>
                {rows.some((d) => d.amountCents !== null) ? (
                  <span className="text-xs text-kumo-subtle">
                    ·{" "}
                    {money(
                      rows.reduce((s, d) => s + (d.amountCents ?? 0), 0),
                      rows[0]?.currency ?? "USD"
                    )}
                  </span>
                ) : null}
              </div>
              <LayerCard className="p-0">
                <div className="divide-y divide-kumo-line">
                  {rows.map((deal) => (
                    <EntityHover
                      key={deal.id}
                      meta={
                        <Badge
                          variant={
                            deal.stage === "won"
                              ? "green"
                              : deal.stage === "lost"
                                ? "neutral"
                                : "blue"
                          }
                        >
                          {STAGE_LABELS[deal.stage]}
                        </Badge>
                      }
                      title={deal.name}
                      description={customerName(deal.customerId)}
                    >
                      <Link
                        to="/$slug/customers/$customerId"
                        params={{
                          slug: workspace.slug,
                          customerId: deal.customerId,
                        }}
                        onClick={peek.peekOnClick(deal)}
                        className="flex h-11 items-center gap-3 px-4 hover:bg-kumo-tint"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                          {deal.name}
                        </span>
                        <span className="text-xs text-kumo-subtle truncate max-w-28">
                          {customerName(deal.customerId)}
                        </span>
                        <span className="w-20 text-right text-sm text-kumo-default">
                          {money(deal.amountCents, deal.currency)}
                        </span>
                        <FieldMenu
                          title="Stage"
                          options={[...STAGES]}
                          labels={STAGE_LABELS}
                          onSelect={(v) =>
                            patch.mutate({ id: deal.id, body: { stage: v } })
                          }
                        >
                          <button
                            type="button"
                            onClick={(e) => e.preventDefault()}
                            className="cursor-pointer"
                          >
                            <Badge
                              variant={
                                deal.stage === "won"
                                  ? "green"
                                  : deal.stage === "lost"
                                    ? "neutral"
                                    : "blue"
                              }
                            >
                              {STAGE_LABELS[deal.stage]}
                            </Badge>
                          </button>
                        </FieldMenu>
                        <span className="w-16 shrink-0 text-right text-xs text-kumo-subtle">
                          {formatRelative(deal.updatedAt)}
                        </span>
                      </Link>
                    </EntityHover>
                  ))}
                </div>
              </LayerCard>
            </div>
          );
        })}
      </div>
      <peek.Drawer>
        {peek.peeked ? (
          <>
            <PeekHeader
              meta={
                <Badge
                  variant={
                    peek.peeked.stage === "won"
                      ? "green"
                      : peek.peeked.stage === "lost"
                        ? "neutral"
                        : "blue"
                  }
                >
                  {STAGE_LABELS[peek.peeked.stage]}
                </Badge>
              }
              title={peek.peeked.name}
              href={`/${workspace.slug}/customers/${peek.peeked.customerId}`}
            />
            <div className="mt-4 flex flex-col gap-2 text-sm text-kumo-subtle">
              <div>Customer: {customerName(peek.peeked.customerId)}</div>
              {peek.peeked.amountCents !== null ? (
                <div>
                  {money(peek.peeked.amountCents, peek.peeked.currency)}
                </div>
              ) : null}
              {peek.peeked.expectedCloseAt ? (
                <div>Expected {peek.peeked.expectedCloseAt.slice(0, 10)}</div>
              ) : null}
            </div>
          </>
        ) : null}
      </peek.Drawer>
    </>
  );
}

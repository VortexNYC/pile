import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Plus, TrendUp } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityHover } from "@/components/entity-hover";
import { FieldMenu } from "@/components/field-menu";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { fetchAllCustomers, fetchAllDeals } from "@/lib/crm-lists";
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

export function formatDealAmount(
  cents: number | null,
  currency: string | null
): string {
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
  // PILE-653 — the pipeline only reads picker fields, so fetch summary
  // rows and follow nextCursor until the bounded endpoints run dry.
  const customers = useQuery({
    queryKey: wsKey(workspace.id, "customers", "summary"),
    queryFn: () =>
      fetchAllCustomers({ organizationId: workspace.id, summary: true }),
  });
  const customerName = (id: string) =>
    customers.data?.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const deals = useQuery({
    queryKey: wsKey(workspace.id, "deals"),
    queryFn: () =>
      fetchAllDeals({ organizationId: workspace.id, summary: true }),
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
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

  const onDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    const next = event.over ? String(event.over.id) : null;
    if (next && (STAGES as readonly string[]).includes(next)) {
      patch.mutate({ id, body: { stage: next } });
    }
  };

  if (deals.isPending) return <LoadingState label="Loading deals" />;
  if (deals.isError) {
    return (
      <ErrorState error={deals.error} onRetry={() => void deals.refetch()} />
    );
  }

  const open = (deals.data ?? []).filter((d) => !d.archivedAt);
  const openDeals = open.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openValue = openDeals.reduce((s, d) => s + (d.amountCents ?? 0), 0);
  const weighted = openDeals.reduce(
    (s, d) =>
      s +
      (d.amountCents ?? 0) *
        ({ lead: 0.1, qualified: 0.25, proposal: 0.5, negotiation: 0.75 }[
          d.stage as string
        ] ?? 0),
    0
  );
  const cur = open.find((d) => d.currency)?.currency ?? "USD";
  const fmt = (cents: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  const total = fmt(openValue);
  const weightedTotal = fmt(weighted);
  // Reporting strip — win rate over closed deals, 90-day forecast over
  // open ones, the same math Attio shows on a pipeline header.
  const wonDeals = open.filter((d) => d.stage === "won");
  const lostDeals = open.filter((d) => d.stage === "lost");
  const closed = wonDeals.length + lostDeals.length;
  const winRate =
    closed > 0 ? Math.round((wonDeals.length / closed) * 100) : null;
  const horizon = Date.now() + 90 * 24 * 3600 * 1000;
  const forecast = fmt(
    openDeals
      .filter(
        (d) => d.expectedCloseAt && Date.parse(d.expectedCloseAt) <= horizon
      )
      .reduce((s, d) => s + (d.amountCents ?? 0), 0)
  );

  if (open.length === 0) {
    return (
      <EmptyState
        icon={<TrendUp size={40} />}
        title="No deals yet"
        description="Track opportunities against customers — stage, amount, and close date."
        action={
          <Button
            icon={<Plus />}
            onClick={() =>
              window.dispatchEvent(new CustomEvent("pile:create-deal"))
            }
          >
            New deal
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3 text-sm">
          <span className="font-medium text-kumo-default">{total} open</span>
          <span className="text-kumo-subtle">·</span>
          <span className="text-kumo-subtle">
            {weightedTotal} weighted · {openDeals.length} open
            {winRate !== null ? ` · ${winRate}% win rate` : ""} · {forecast}{" "}
            closing 90d
          </span>
        </div>
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
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex flex-col gap-5">
          {STAGES.map((stage) => {
            const rows = open.filter((d) => d.stage === stage);
            if (rows.length === 0) return null;
            return (
              <DroppableGroup key={stage} id={stage}>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 px-1 pb-1.5">
                    <span className="text-xs font-medium text-kumo-subtle uppercase">
                      {STAGE_LABELS[stage]}
                    </span>
                    <span className="text-xs text-kumo-subtle">
                      {rows.length}
                    </span>
                    {rows.some((d) => d.amountCents !== null) ? (
                      <span className="text-xs text-kumo-subtle">
                        ·{" "}
                        {formatDealAmount(
                          rows.reduce((s, d) => s + (d.amountCents ?? 0), 0),
                          rows[0]?.currency ?? "USD"
                        )}
                      </span>
                    ) : null}
                  </div>
                  <LayerCard className="p-0">
                    <div className="divide-y divide-kumo-line">
                      {rows.map((deal) => (
                        <DraggableRow key={deal.id} id={deal.id}>
                          <EntityHover
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
                              to="/$slug/deals/$dealId"
                              params={{ slug: workspace.slug, dealId: deal.id }}

                              className="flex h-11 items-center gap-3 px-4 hover:bg-kumo-tint"
                            >
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">
                                {deal.name}
                              </span>
                              <span className="text-xs text-kumo-subtle truncate max-w-28">
                                {customerName(deal.customerId)}
                              </span>
                              <span className="w-20 text-right text-sm text-kumo-default">
                                {formatDealAmount(
                                  deal.amountCents,
                                  deal.currency
                                )}
                              </span>
                              <FieldMenu
                                title="Stage"
                                options={[...STAGES]}
                                labels={STAGE_LABELS}
                                onSelect={(v) =>
                                  patch.mutate({
                                    id: deal.id,
                                    body: { stage: v },
                                  })
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
                        </DraggableRow>
                      ))}
                    </div>
                  </LayerCard>
                </div>
              </DroppableGroup>
            );
          })}
        </div>
      </DndContext>
    </>
  );
}

function DroppableGroup({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={
        isOver ? "rounded-lg bg-kumo-tint/60 ring-1 ring-kumo-brand" : undefined
      }
    >
      {children}
    </div>
  );
}

function DraggableRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={isDragging ? "opacity-40" : undefined}
    >
      {children}
    </div>
  );
}

import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  CheckCircle,
  Circle,
  CircleHalf,
  ListChecks,
  XCircle,
} from "@phosphor-icons/react";

/** PILE-426 — the agent's published plan checklist. Each session carries an
 *  ordered list of items; the plan replaces wholesale on every update. */

export interface SessionPlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export function planProgress(plan: SessionPlanItem[]): {
  done: number;
  total: number;
} {
  return {
    done: plan.filter(
      (item) => item.status === "completed" || item.status === "canceled"
    ).length,
    total: plan.length,
  };
}

function PlanItemIcon({ status }: { status: SessionPlanItem["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle size={15} className="text-kumo-success" />;
    case "inProgress":
      return <CircleHalf size={15} className="text-kumo-default" />;
    case "canceled":
      return <XCircle size={15} className="text-kumo-subtle" />;
    default:
      return <Circle size={15} className="text-kumo-subtle" />;
  }
}

export function SessionPlanCard({ plan }: { plan: SessionPlanItem[] }) {
  const { done, total } = planProgress(plan);
  return (
    <LayerCard>
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 pb-2">
          <ListChecks size={15} className="text-kumo-subtle" />
          <span className="text-sm font-medium text-kumo-default">Plan</span>
          <span className="text-xs text-kumo-subtle">
            {done}/{total} done
          </span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {plan.map((item, index) => (
            <li
              key={`${index}-${item.content.slice(0, 32)}`}
              className="flex items-start gap-2"
            >
              <span className="pt-0.5 shrink-0">
                <PlanItemIcon status={item.status} />
              </span>
              <span
                className={`text-sm ${
                  item.status === "canceled"
                    ? "text-kumo-subtle line-through"
                    : item.status === "completed"
                      ? "text-kumo-subtle"
                      : "text-kumo-default"
                }`}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </LayerCard>
  );
}

import {
  CheckCircle,
  Circle,
  CircleDashed,
  CircleHalf,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { IssueStatus } from "@/lib/labels";

const ICONS = {
  triage: WarningCircle,
  backlog: CircleDashed,
  todo: Circle,
  in_progress: CircleHalf,
  done: CheckCircle,
  canceled: XCircle,
} as const;

/** Linear's status icon — the state readable at a glance, no text. */
export function IssueStatusIcon({
  status,
  size = 15,
}: {
  status: IssueStatus;
  size?: number;
}) {
  const Icon = ICONS[status];
  const color =
    status === "done"
      ? "text-green-500"
      : status === "canceled"
        ? "text-kumo-subtle"
        : status === "in_progress"
          ? "text-yellow-500"
          : status === "triage"
            ? "text-orange-500"
            : "text-kumo-subtle";
  return (
    <Icon
      size={size}
      weight={status === "in_progress" ? "fill" : "regular"}
      className={`${color} shrink-0`}
      aria-label={status}
    />
  );
}

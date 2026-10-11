import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ReactNode } from "react";

import { Markdown } from "@/components/markdown";
import { formatRelative } from "@/lib/labels";

/** One feed grammar everywhere — the divided LayerCard of rows,
 * each a left marker (badge or icon), markdown content, timestamp.
 * Issues, tickets, and sessions map their own event shapes onto
 * this row instead of hand-rolling card markup per entity. */
export function Feed({ children }: { children: ReactNode }) {
  return (
    <LayerCard className="p-0">
      <div className="divide-y divide-kumo-line">{children}</div>
    </LayerCard>
  );
}

function FeedRow({
  marker,
  body,
  timestamp,
  workspaceSlug,
  compact,
}: {
  /** Left anchor — a status/kind Badge or a small icon. */
  marker: ReactNode;
  /** Markdown content, or raw children for custom layouts. */
  body: string | ReactNode;
  timestamp: string;
  workspaceSlug?: string;
  /** Quieter chrome for tool-trace style rows. */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline gap-3 px-4 ${
        compact ? "py-1.5 text-kumo-subtle" : "py-2.5"
      }`}
    >
      <span className="shrink-0 self-center">{marker}</span>
      <div className={`flex-1 min-w-0 ${compact ? "text-xs" : "text-sm"}`}>
        {typeof body === "string" && workspaceSlug ? (
          <Markdown workspaceSlug={workspaceSlug} content={body} />
        ) : (
          body
        )}
      </div>
      <span className="text-xs text-kumo-subtle shrink-0">
        {formatRelative(timestamp)}
      </span>
    </div>
  );
}
Feed.Row = FeedRow;

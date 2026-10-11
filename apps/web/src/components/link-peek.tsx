import { PreviewCard } from "@base-ui/react/preview-card";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useWorkspace } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  PRIORITY_LABELS,
  priorityVariant,
} from "@/lib/labels";

/** Peek inside content — an ISS-123 link in a description/comment
 * renders its issue card on hover. Lazily fetches on first open. */
export function IssueLinkPeek({
  identifier,
  children,
}: {
  identifier: string;
  children: React.ReactElement;
}) {
  const workspace = useWorkspace();
  const [opened, setOpened] = useState(false);
  const issue = useQuery({
    queryKey: ["peek-issue", workspace.id, identifier],
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: {
              path: { organizationId: workspace.id },
              query: { identifier, limit: 1 },
            },
          })
        )
      ).issues[0],
    enabled: opened,
    staleTime: 60_000,
  });

  return (
    <PreviewCard.Root
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
    >
      <PreviewCard.Trigger render={children} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner>
          <PreviewCard.Popup className="border-kumo-line bg-kumo-canvas w-80 rounded-lg border p-4 shadow-lg">
            {issue.data ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-kumo-subtle">
                    {identifier}
                  </span>
                  <Badge variant={issueStatusVariant(issue.data.status)}>
                    {ISSUE_STATUS_LABELS[issue.data.status]}
                  </Badge>
                  <Badge variant={priorityVariant(issue.data.priority)}>
                    {PRIORITY_LABELS[issue.data.priority]}
                  </Badge>
                </div>
                <p className="text-sm font-medium text-kumo-default">
                  {issue.data.title}
                </p>
                {issue.data.description ? (
                  <p className="text-xs text-kumo-subtle line-clamp-3">
                    {issue.data.description}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-kumo-subtle">Loading…</p>
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

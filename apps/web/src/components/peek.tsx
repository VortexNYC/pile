import { PreviewCard } from "@base-ui/react/preview-card";
import { Badge } from "@cloudflare/kumo/components/badge";

import {
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  PRIORITY_LABELS,
  priorityVariant,
  type IssuePriority,
  type IssueStatus,
} from "@/lib/labels";

/** Linear's peek — hover a link, get the entity's preview card
 * without navigating. Wraps any trigger element. */

interface PeekIssue {
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  description?: string | null;
}

export function IssuePeek({
  issue,
  children,
}: {
  issue: PeekIssue;
  children: React.ReactElement;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={children} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner>
          <PreviewCard.Popup className="border-kumo-line bg-kumo-canvas w-80 rounded-lg border p-4 shadow-lg">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {issue.identifier ? (
                  <span className="text-xs font-medium text-kumo-subtle">
                    {issue.identifier}
                  </span>
                ) : null}
                <Badge variant={issueStatusVariant(issue.status)}>
                  {ISSUE_STATUS_LABELS[issue.status]}
                </Badge>
                <Badge variant={priorityVariant(issue.priority)}>
                  {PRIORITY_LABELS[issue.priority]}
                </Badge>
              </div>
              <p className="text-sm font-medium text-kumo-default">
                {issue.title}
              </p>
              {issue.description ? (
                <p className="text-xs text-kumo-subtle line-clamp-3">
                  {issue.description}
                </p>
              ) : null}
            </div>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

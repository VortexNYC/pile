import { ContextMenu } from "@base-ui/react/context-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, stageGateBlockMessage, unwrap, unwrapEmpty } from "@/lib/api";
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES } from "@/lib/labels";
import { toastError, toastManager } from "@/lib/toast";

const itemClass =
  "flex cursor-default items-center px-3 py-1.5 text-sm text-kumo-default outline-none data-[highlighted]:bg-kumo-tint";
const labelClass = "px-3 py-1 text-xs font-medium text-kumo-subtle";

interface IssueRow {
  id: string;
  identifier: string | null;
  status: string;
}

/** Absolute console URL for an issue — copy-link target. */
export function issuePermalink(
  origin: string,
  slug: string,
  issueId: string
): string {
  return `${origin}/app/${slug}/issues/${issueId}`;
}

/** Right-click row menu — Circle's issue context actions:
 * change status, copy identifier/link, delete. */
export function IssueContextMenu({
  issue,
  children,
}: {
  issue: IssueRow;
  children: React.ReactElement;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: wsKey(workspace.id, "issues"),
    });

  const setStatus = useMutation({
    mutationFn: (status: string) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/issues/{id}", {
          params: { path: { organizationId: workspace.id, id: issue.id } },
          body: { status: status as never },
        })
      ),
    onSuccess: invalidate,
    // PILE-412 — surface the stage gate's blocking sub-steps on 409.
    onError: (error) => {
      const blocked = stageGateBlockMessage(error);
      if (blocked) toastManager.add({ title: blocked, variant: "error" });
      else toastError(error);
    },
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/issues/{id}", {
          params: { path: { organizationId: workspace.id, id: issue.id } },
        })
      ),
    onSuccess: invalidate,
    onError: (error) => toastError(error),
  });

  const issueUrl = issuePermalink(
    window.location.origin,
    workspace.slug,
    issue.id
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup className="border-kumo-line bg-kumo-canvas min-w-44 rounded-lg border p-1 shadow-lg">
            <ContextMenu.Group>
              <ContextMenu.GroupLabel className={labelClass}>
                Status
              </ContextMenu.GroupLabel>
              {ISSUE_STATUSES.filter((s) => s !== issue.status).map((s) => (
                <ContextMenu.Item
                  key={s}
                  className={itemClass}
                  onClick={() => setStatus.mutate(s)}
                >
                  {ISSUE_STATUS_LABELS[s]}
                </ContextMenu.Item>
              ))}
            </ContextMenu.Group>
            <ContextMenu.Separator className="bg-kumo-line mx-1 my-1 h-px" />
            {issue.identifier ? (
              <ContextMenu.Item
                className={itemClass}
                onClick={() => navigator.clipboard.writeText(issue.identifier!)}
              >
                Copy identifier
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              className={itemClass}
              onClick={() => navigator.clipboard.writeText(issueUrl)}
            >
              Copy link
            </ContextMenu.Item>
            <ContextMenu.Item
              className={itemClass}
              onClick={() =>
                window.open(`/app/${workspace.slug}/issues/${issue.id}`)
              }
            >
              Open in new tab
            </ContextMenu.Item>
            <ContextMenu.Separator className="bg-kumo-line mx-1 my-1 h-px" />
            <ContextMenu.Item
              className={`${itemClass} text-kumo-danger`}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this issue"
        description="This can't be undone."
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
      />
    </ContextMenu.Root>
  );
}

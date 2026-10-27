import { useMutation, useQueryClient } from "@tanstack/react-query";

import { FieldMenu } from "@/components/field-menu";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, stageGateBlockMessage, unwrap } from "@/lib/api";
import { toastError, toastManager } from "@/lib/toast";

/** Field edits only change issue-shaped state — invalidate the issues
 * subtree (lists + detail), not the whole workspace root, which previously
 * refetched notifications, documents, sessions, and everything else under
 * `wsKey(workspace.id)`. */
export function issueFieldInvalidationKey(workspaceId: string) {
  return wsKey(workspaceId, "issues");
}

/** Linear's inline edit — click a field chip, pick a value from the
 * popover, PATCH in place. No edit mode. */
export function IssueFieldMenu({
  issue,
  field,
  options,
  labels,
  children,
}: {
  issue: { id: string };
  field: "status" | "priority";
  options: readonly string[];
  labels: Record<string, string>;
  children: React.ReactElement;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/issues/{id}", {
          params: { path: { organizationId: workspace.id, id: issue.id } },
          body: { [field]: value } as never,
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: issueFieldInvalidationKey(workspace.id),
      }),
    // PILE-412 — a stage-gate 409 names the blocking sub-steps; show them
    // instead of letting the transition fail silently.
    onError: (error) => {
      const blocked = stageGateBlockMessage(error);
      if (blocked) toastManager.add({ title: blocked, variant: "error" });
      else toastError(error);
    },
  });

  return (
    <FieldMenu
      title={field === "status" ? "Status" : "Priority"}
      options={options}
      labels={labels}
      onSelect={(v) => patch.mutate(v)}
    >
      {children}
    </FieldMenu>
  );
}

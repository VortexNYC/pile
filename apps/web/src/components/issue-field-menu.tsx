import { useMutation, useQueryClient } from "@tanstack/react-query";

import { FieldMenu } from "@/components/field-menu";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

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
        queryKey: wsKey(workspace.id),
      }),
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

import { Menu } from "@base-ui/react/menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

const itemClass =
  "flex cursor-default items-center px-3 py-1.5 text-sm text-kumo-default outline-none data-[highlighted]:bg-kumo-tint";
const labelClass = "px-3 py-1 text-xs font-medium text-kumo-subtle";

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
    <Menu.Root>
      <Menu.Trigger render={children} />
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup className="border-kumo-line bg-kumo-canvas min-w-36 rounded-lg border p-1 shadow-lg">
            <Menu.Group>
              <Menu.GroupLabel className={labelClass}>
                {field === "status" ? "Status" : "Priority"}
              </Menu.GroupLabel>
              {options.map((opt) => (
                <Menu.Item
                  key={opt}
                  className={itemClass}
                  onClick={() => patch.mutate(opt)}
                >
                  {labels[opt] ?? opt}
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

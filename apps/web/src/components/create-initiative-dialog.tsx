import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

/** New-initiative dialog — same create grammar as issue/ticket/deal. */
export function CreateInitiativeDialog({
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const onOpenChange = onOpenChangeProp ?? setInternal;
  useEffect(() => {
    const onOpen = () => onOpenChange(true);
    window.addEventListener("pile:create-initiative", onOpen);
    return () => window.removeEventListener("pile:create-initiative", onOpen);
  }, [onOpenChange]);

  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [roadmapId, setRoadmapId] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");

  const roadmaps = useQuery({
    queryKey: wsKey(workspace.id, "roadmaps"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/roadmaps", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).roadmaps,
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/initiatives", {
          params: { path: { organizationId: workspace.id } },
          body: {
            name: name.trim(),
            description: description.trim() || undefined,
            roadmapId: roadmapId || undefined,
            targetDate: targetDate || undefined,
          },
        })
      ),
    onSuccess: () => {
      setName("");
      setDescription("");
      setTargetDate("");
      setRoadmapId("");
      onOpenChange(false);
      toastSuccess("Initiative created");
    },
    onError: (error) => toastError(error),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "initiatives"),
      }),
  });

  const valid = name.trim().length > 0;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>New initiative</DialogTitle>
        <form
          aria-label="New initiative"
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <Input
            label="Name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
          {(roadmaps.data ?? []).length > 0 ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Roadmap
              </label>
              <Select
                aria-label="Roadmap"
                value={roadmapId}
                onValueChange={(v) => setRoadmapId(v ?? "")}
                placeholder="No roadmap"
              >
                {(roadmaps.data ?? []).map((r) => (
                  <Select.Option key={r.id} value={r.id}>
                    {r.name}
                  </Select.Option>
                ))}
              </Select>
            </div>
          ) : null}
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Input
            label="Target date"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose
              render={
                <Button variant="ghost" type="button">
                  Cancel
                </Button>
              }
            />
            <Button
              variant="primary"
              type="submit"
              disabled={!valid}
              loading={create.isPending}
            >
              Create initiative
            </Button>
          </div>
        </form>
      </Dialog>
    </DialogRoot>
  );
}

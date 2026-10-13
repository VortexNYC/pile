import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

/** New-roadmap dialog — same create grammar as initiative/deal. */
export function CreateRoadmapDialog({
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
    window.addEventListener("pile:create-roadmap", onOpen);
    return () => window.removeEventListener("pile:create-roadmap", onOpen);
  }, [onOpenChange]);

  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/roadmaps", {
          params: { path: { organizationId: workspace.id } },
          body: {
            name: name.trim(),
            description: description.trim() || undefined,
          },
        })
      ),
    onSuccess: () => {
      setName("");
      setDescription("");
      onOpenChange(false);
      toastSuccess("Roadmap created");
    },
    onError: (error) => toastError(error),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "roadmaps"),
      }),
  });

  const valid = name.trim().length > 0;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>New roadmap</DialogTitle>
        <form
          aria-label="New roadmap"
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
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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
              Create roadmap
            </Button>
          </div>
        </form>
      </Dialog>
    </DialogRoot>
  );
}

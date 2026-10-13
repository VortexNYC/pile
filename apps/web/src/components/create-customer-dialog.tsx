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

/** Add-company dialog — matches the issue/ticket create grammar. */
export function CreateCustomerDialog({
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
    window.addEventListener("pile:create-customer", onOpen);
    return () => window.removeEventListener("pile:create-customer", onOpen);
  }, [onOpenChange]);
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const key = wsKey(workspace.id, "customers");

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/customers", {
          params: { path: { organizationId: workspace.id } },
          body: { name: name.trim(), url: url.trim() || undefined },
        })
      ),
    onSuccess: () => {
      setName("");
      setUrl("");
      onOpenChange(false);
      toastSuccess("Company added");
    },
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>Add company</DialogTitle>
        <form
          aria-label="Add customer"
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !create.isPending) create.mutate();
          }}
        >
          <Input
            label="Company name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Website"
            type="url"
            placeholder="https://example.com"
            value={url}
            required={false}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              disabled={!name.trim()}
            >
              Save customer
            </Button>
          </div>
        </form>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

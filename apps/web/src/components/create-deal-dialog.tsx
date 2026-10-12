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

const STAGES = [
  ["lead", "Lead"],
  ["qualified", "Qualified"],
  ["proposal", "Proposal"],
  ["negotiation", "Negotiation"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;

/** New-deal dialog — same create grammar as issue/ticket/customer. */
export function CreateDealDialog({
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
    window.addEventListener("pile:create-deal", onOpen);
    return () => window.removeEventListener("pile:create-deal", onOpen);
  }, [onOpenChange]);

  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [stage, setStage] = useState<string>("lead");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");

  const customers = useQuery({
    queryKey: wsKey(workspace.id, "customers"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/deals", {
          params: { path: { organizationId: workspace.id } },
          body: {
            customerId,
            name: name.trim(),
            stage: stage as never,
            amountCents: amount ? Math.round(parseFloat(amount) * 100) : null,
            currency: currency || null,
          },
        })
      ),
    onSuccess: () => {
      setName("");
      setAmount("");
      onOpenChange(false);
      toastSuccess("Deal created");
    },
    onError: (error) => toastError(error),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: wsKey(workspace.id, "deals") }),
  });

  const valid = name.trim().length > 0 && customerId.length > 0;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>New deal</DialogTitle>
        <form
          aria-label="New deal"
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !create.isPending) create.mutate();
          }}
        >
          <Input
            label="Deal name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-kumo-subtle">
              Customer
            </label>
            <Select
              aria-label="Customer"
              value={customerId}
              onValueChange={(v) => v && setCustomerId(v)}
            >
              {(customers.data ?? []).map((c) => (
                <Select.Option key={c.id} value={c.id}>
                  {c.name}
                </Select.Option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Stage
              </label>
              <Select
                aria-label="Stage"
                value={stage}
                onValueChange={(v) => v && setStage(v)}
              >
                {STAGES.map(([value, label]) => (
                  <Select.Option key={value} value={value}>
                    {label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <Input
              label="Amount"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={amount}
              required={false}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Input
              label="Currency"
              value={currency}
              required={false}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
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
              disabled={!valid}
            >
              Create deal
            </Button>
          </div>
        </form>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

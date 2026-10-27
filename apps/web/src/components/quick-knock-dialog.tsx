import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { DoorOpen } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { quotedAmountCents } from "@/components/log-touch-dialog";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { ApiError, errorMessage } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

import type { CustomerTouchOutcome } from "../../../../src/workspace/touch-outcomes.js";

/** Stoop-speed outcome pills — the labels a rep taps, mapped onto the
 *  canonical CUSTOMER_TOUCH_OUTCOMES vocabulary the API accepts. */
const OUTCOME_PILLS: ReadonlyArray<{
  outcome: CustomerTouchOutcome;
  label: string;
}> = [
  { outcome: "talked", label: "Talked" },
  { outcome: "quoted", label: "Quoted" },
  { outcome: "callback", label: "Come back" },
  { outcome: "sent_info", label: "Left card" },
  { outcome: "no_answer", label: "No answer" },
  { outcome: "not_interested", label: "Not interested" },
];

type NextStepPreset = "tomorrow" | "three_days" | "next_week" | "none";

const NEXT_STEP_PILLS: ReadonlyArray<{
  preset: NextStepPreset;
  label: string;
}> = [
  { preset: "tomorrow", label: "Tomorrow" },
  { preset: "three_days", label: "3 days" },
  { preset: "next_week", label: "Next week" },
  { preset: "none", label: "None" },
];

interface QuickKnockBody {
  name: string;
  addressLine1?: string;
  phone?: string;
  outcome: CustomerTouchOutcome;
  summary?: string;
  channel: "visit";
  nextStepPreset?: NextStepPreset;
  quotedAmountCents?: number;
}

interface QuickKnockResponse {
  customer: { id: string; name: string };
  created: boolean;
  deal: { id: string; name: string } | null;
}

/** POST to the quick-knock route. The generated API client types lag new
 *  endpoints until `client:generate` runs, so this goes through a plain
 *  fetch with the same credentials/base as `api`. */
async function postQuickKnock(
  organizationId: string,
  body: QuickKnockBody
): Promise<QuickKnockResponse> {
  const response = await fetch(
    `/workspaces/${organizationId}/customers/quick-knock`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      errorMessage(json, `Request failed (${response.status})`),
      response.status
    );
  }
  return json as QuickKnockResponse;
}

/** PILE-671 — "Log a Knock" mobile quick-add: big touch targets, four
 *  fields, optional quote, one-tap next step. Built for ~375px stoop use
 *  in under 15 seconds. */
export function QuickKnockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<CustomerTouchOutcome>("talked");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [quotedAmount, setQuotedAmount] = useState("");
  const [nextStep, setNextStep] = useState<NextStepPreset>("tomorrow");
  const [note, setNote] = useState("");

  // Fresh draft every open — stoop captures are one-shot.
  useEffect(() => {
    if (open) {
      setOutcome("talked");
      setName("");
      setAddress("");
      setPhone("");
      setQuotedAmount("");
      setNextStep("tomorrow");
      setNote("");
    }
  }, [open]);

  const submit = useMutation({
    mutationFn: async () => {
      const body: QuickKnockBody = {
        name: name.trim(),
        outcome,
        channel: "visit",
        nextStepPreset: nextStep,
      };
      if (address.trim()) body.addressLine1 = address.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (note.trim()) body.summary = note.trim();
      const cents = quotedAmountCents(quotedAmount);
      if (cents !== null) body.quotedAmountCents = cents;
      return postQuickKnock(workspace.id, body);
    },
    onSuccess: (result) => {
      onOpenChange(false);
      toastSuccess(
        result.created
          ? `Knock logged — ${result.customer.name} added`
          : `Knock logged on ${result.customer.name}`
      );
    },
    onError: (error) => toastError(error, "Could not log knock"),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "customers"),
      });
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals"),
      });
    },
  });

  const valid = name.trim().length > 0;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="w-full max-w-sm p-4 sm:p-6">
        <DialogTitle className="flex items-center gap-2">
          <DoorOpen size={18} />
          Log a Knock
        </DialogTitle>
        <form
          aria-label="Log a knock"
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !submit.isPending) submit.mutate();
          }}
        >
          {/* Outcome first — the rep taps it while walking away. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-kumo-subtle">
              Outcome
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              {OUTCOME_PILLS.map(({ outcome: value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={outcome === value}
                  onClick={() => setOutcome(value)}
                  className={`min-h-11 rounded-lg border px-2 text-sm font-medium transition-colors ${
                    outcome === value
                      ? "border-kumo-default bg-kumo-tint text-kumo-default"
                      : "border-kumo-line text-kumo-subtle hover:text-kumo-default"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Input
            label="Name / building"
            value={name}
            required
            autoComplete="off"
            enterKeyHint="next"
            placeholder="e.g. Sal's Hardware"
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Street address"
            value={address}
            required={false}
            autoComplete="off"
            enterKeyHint="next"
            placeholder="123 Atlantic Ave"
            onChange={(e) => setAddress(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Phone (optional)"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              required={false}
              onChange={(e) => setPhone(e.target.value)}
            />
            <Input
              label="Quoted $"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={quotedAmount}
              required={false}
              placeholder={outcome === "quoted" ? "225" : "Optional"}
              onChange={(e) => setQuotedAmount(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-kumo-subtle">
              Next step
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {NEXT_STEP_PILLS.map(({ preset, label }) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={nextStep === preset}
                  onClick={() => setNextStep(preset)}
                  className={`min-h-11 rounded-lg border px-2 text-sm font-medium transition-colors ${
                    nextStep === preset
                      ? "border-kumo-default bg-kumo-tint text-kumo-default"
                      : "border-kumo-line text-kumo-subtle hover:text-kumo-default"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Input
            label="Note"
            value={note}
            required={false}
            autoCapitalize="sentences"
            enterKeyHint="done"
            placeholder="One line — dictate it"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submit.isPending}
              disabled={!valid}
            >
              Log knock
            </Button>
          </div>
        </form>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

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

import {
  CUSTOMER_TOUCH_OUTCOMES,
  type CustomerTouchOutcome,
  isCustomerTouchOutcome,
  OUTCOME_DEFAULTS,
  resolveOutcomeStatusId,
} from "../../../../src/workspace/touch-outcomes.js";

export const LOG_TOUCH_OUTCOME_OPTIONS = CUSTOMER_TOUCH_OUTCOMES.map(
  (value) => ({ value, label: OUTCOME_DEFAULTS[value].label })
);

/** Draft next-step fields seeded by the outcome's defaults — terminal
 *  outcomes prefill nothing (they clear the pending step server-side). */
export function nextStepPrefill(outcome: CustomerTouchOutcome): {
  text: string;
  date: string;
} {
  const defaults = OUTCOME_DEFAULTS[outcome];
  if (defaults.clearNextStep === true) return { text: "", date: "" };
  const dueAt = defaults.dueInDays
    ? new Date(Date.now() + defaults.dueInDays * 86_400_000)
    : null;
  return {
    text: defaults.nextStepText ?? "",
    date: dueAt ? dueAt.toISOString().slice(0, 10) : "",
  };
}

/** `<input type="date">` value → ISO timestamp (start of that local day);
 *  empty string → null so the caller can distinguish "cleared". */
export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** PILE-673 — dollars as typed → integer cents for quotedAmountCents.
 *  "225" → 22500, "225.50" → 22550; blank/unparseable/non-positive → null. */
export function quotedAmountCents(amount: string): number | null {
  if (!amount.trim()) return null;
  const dollars = Number.parseFloat(amount);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

/** "Log touch" — Ronnie's post-knock record: pick the outcome, optionally
 *  adjust the note / next step, and the API applies the stage auto-advance
 *  and next-step defaults. */
export function LogTouchDialog({
  customerId,
  customerName,
  open,
  onOpenChange,
}: {
  customerId: string | null;
  customerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<CustomerTouchOutcome>("talked");
  const [note, setNote] = useState("");
  const [nextStepText, setNextStepText] = useState("");
  const [nextStepDate, setNextStepDate] = useState("");
  // PILE-673 — dollars as typed ("225" → 22500 cents server-side).
  const [quotedAmount, setQuotedAmount] = useState("");

  // Re-seed the draft each time the dialog targets a new customer.
  useEffect(() => {
    if (open) {
      setOutcome("talked");
      setNote("");
      setQuotedAmount("");
      const prefill = nextStepPrefill("talked");
      setNextStepText(prefill.text);
      setNextStepDate(prefill.date);
    }
  }, [open, customerId]);

  const statuses = useQuery({
    queryKey: wsKey(workspace.id, "customer-statuses"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customer-statuses", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).statuses,
    enabled: open,
    staleTime: 30_000,
  });
  const advancedStatusId = resolveOutcomeStatusId(outcome, statuses.data ?? []);
  const stageHint = advancedStatusId
    ? (statuses.data ?? []).find((s) => s.id === advancedStatusId)?.name
    : undefined;

  const submit = useMutation({
    mutationFn: async () => {
      const prefill = nextStepPrefill(outcome);
      const body: {
        outcome: CustomerTouchOutcome;
        note?: string;
        nextStepText?: string;
        nextStepDueAt?: string;
        quotedAmountCents?: number;
      } = { outcome };
      if (note.trim()) body.note = note.trim();
      const cents = quotedAmountCents(quotedAmount);
      if (cents !== null) body.quotedAmountCents = cents;
      // Only send overrides the user actually changed — the server fills
      // outcome defaults otherwise.
      if (nextStepText !== prefill.text && nextStepText !== "")
        body.nextStepText = nextStepText;
      if (nextStepDate !== prefill.date) {
        const iso = dateInputToIso(nextStepDate);
        if (iso) body.nextStepDueAt = iso;
      }
      return unwrap(
        api.POST("/workspaces/{organizationId}/customers/{id}/interactions", {
          params: {
            path: { organizationId: workspace.id, id: customerId! },
          },
          body,
        })
      );
    },
    onSuccess: (result) => {
      onOpenChange(false);
      if (result.stageBlocked) {
        toastError(
          new Error(
            "Touch logged — stage advance blocked by open required sub-steps"
          )
        );
      } else {
        toastSuccess(
          `Touch logged${result.stageAdvanced ? " — stage advanced" : ""}`
        );
      }
    },
    onError: (error) => toastError(error, "Could not log touch"),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "customers"),
      });
      // A quoted amount bridges into the pipeline — refresh deals too.
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals"),
      });
    },
  });

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>Log touch — {customerName}</DialogTitle>
        <form
          aria-label="Log touch"
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (customerId && !submit.isPending) submit.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-kumo-subtle">
              Outcome
            </label>
            <Select
              aria-label="Outcome"
              value={outcome}
              onValueChange={(v) => {
                if (!isCustomerTouchOutcome(v)) return;
                const next = v;
                const previousPrefill = nextStepPrefill(outcome);
                setOutcome(next);
                // Re-seed the next step only where the rep hasn't already
                // typed something different from the old default.
                const nextPrefill = nextStepPrefill(next);
                if (
                  nextStepText === "" ||
                  nextStepText === previousPrefill.text
                )
                  setNextStepText(nextPrefill.text);
                if (
                  nextStepDate === "" ||
                  nextStepDate === previousPrefill.date
                )
                  setNextStepDate(nextPrefill.date);
              }}
            >
              {LOG_TOUCH_OUTCOME_OPTIONS.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Select.Option>
              ))}
            </Select>
            {stageHint && (
              <span className="text-[11px] text-kumo-subtle">
                Stage advances to {stageHint}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-kumo-subtle">Note</label>
            <textarea
              aria-label="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="What happened at the door…"
              className="rounded border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm text-kumo-default"
            />
          </div>
          <Input
            label="Quoted amount ($)"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={quotedAmount}
            required={false}
            placeholder={outcome === "quoted" ? "225" : "Optional — e.g. 225"}
            onChange={(e) => setQuotedAmount(e.target.value)}
          />
          <Input
            label="Next step"
            value={nextStepText}
            required={false}
            placeholder={OUTCOME_DEFAULTS[outcome].nextStepText ?? "Optional"}
            onChange={(e) => setNextStepText(e.target.value)}
          />
          <Input
            label="Due date"
            type="date"
            value={nextStepDate}
            required={false}
            onChange={(e) => setNextStepDate(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={submit.isPending}>
              Log touch
            </Button>
          </div>
        </form>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

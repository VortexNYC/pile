import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";

/** One destructive-confirm for the whole app — replaces every
 * window.confirm. Control it by rendering <ConfirmDialog>
 * conditionally; onConfirm fires your mutation. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>{title}</DialogTitle>
        {description ? (
          <p className="mt-2 text-sm text-kumo-subtle">{description}</p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button variant="destructive" loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import type { ReactNode } from "react";

/** Click-to-peek — a compact dialog over the list so the entity's
 * content is visible without navigating away. Esc/backdrop dismisses;
 * PeekHeader carries the open-in-full action. */
export function PeekDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-2xl p-6">
        <DialogTitle className="sr-only">Preview</DialogTitle>
        <div className="max-h-[75vh] overflow-y-auto">{children}</div>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

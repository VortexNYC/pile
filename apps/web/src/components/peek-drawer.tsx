import { Dialog } from "@base-ui/react/dialog";
import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** Linear's peek — clicking a row slides the detail in from the
 * right instead of navigating away. The list stays underneath;
 * Esc/backdrop dismisses. */
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Popup className="bg-kumo-canvas fixed top-0 right-0 bottom-0 z-50 w-full max-w-lg overflow-y-auto border-l border-kumo-line shadow-2xl">
          <div className="sticky top-0 z-10 flex justify-end bg-kumo-canvas/95 backdrop-blur-sm p-2">
            <Dialog.Close
              aria-label="Close"
              className="hover:bg-kumo-tint rounded-md p-1.5 text-kumo-subtle"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="px-6 pb-8">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { createKumoToastManager } from "@cloudflare/kumo/components/toast";

export const toastManager = createKumoToastManager();

export function toastError(error: unknown, fallback = "Something went wrong") {
  toastManager.add({
    title: error instanceof Error ? error.message : fallback,
    variant: "error",
  });
}

export function toastSuccess(title: string) {
  toastManager.add({ title, variant: "success" });
}

import { Toasty } from "@cloudflare/kumo/components/toast";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Outlet,
} from "@tanstack/react-router";

import { EmptyState, ErrorState } from "@/components/states";
import { toastManager } from "@/lib/toast";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: () => (
    <div className="p-10">
      <EmptyState
        title="Page not found"
        description="The page you're looking for doesn't exist."
      />
    </div>
  ),
});

function RootComponent() {
  return (
    <Toasty toastManager={toastManager}>
      <div className="min-h-dvh">
        <Outlet />
      </div>
    </Toasty>
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="p-10">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}

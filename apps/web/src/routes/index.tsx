import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { ErrorState, LoadingState } from "@/components/states";
import { workspacesQuery } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

export const Route = createFileRoute("/")({
  component: Bootstrap,
});

/** /app → sign-in, onboarding, or the first workspace's issues. */
function Bootstrap() {
  const { data: session, isPending } = betterAuthClient.useSession();
  const workspaces = useQuery({ ...workspacesQuery, enabled: !!session });

  if (isPending || (session && workspaces.isPending)) {
    return <LoadingState />;
  }
  if (!session) {
    return <Navigate to="/sign-in" replace />;
  }
  if (workspaces.isError) {
    return (
      <div className="p-10">
        <ErrorState
          error={workspaces.error}
          onRetry={() => void workspaces.refetch()}
        />
      </div>
    );
  }
  const first = workspaces.data?.[0];
  if (!first) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Navigate to="/$slug/issues" params={{ slug: first.slug }} replace />;
}

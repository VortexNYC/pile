import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

/** Media gallery across all tickets — reused by the captures route
 * and the Support tab. */
export function CapturesGrid() {
  const workspace = useWorkspace();
  const captures = useQuery({
    queryKey: wsKey(workspace.id, "captures"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/captures", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).captures,
  });

  if (captures.isPending) return <LoadingState label="Loading captures" />;
  if (captures.isError) {
    return (
      <ErrorState
        error={captures.error}
        onRetry={() => void captures.refetch()}
      />
    );
  }
}

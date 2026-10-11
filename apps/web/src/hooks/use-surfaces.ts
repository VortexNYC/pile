import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

/** Sparse data types default off — the toggle in Settings → Surfaces
 * exposes them for people who want them. Everything else defaults on. */
const DEFAULT_HIDDEN = new Set(["cycles", "initiatives", "roadmaps"]);

export function useSurfaces(organizationId: string) {
  const queryClient = useQueryClient();
  const key = wsKey(organizationId, "view-preferences");

  const prefs = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
        })
      ),
  });

  const hidden = new Set(prefs.data?.hiddenSurfaces ?? [...DEFAULT_HIDDEN]);

  const update = useMutation({
    mutationFn: (hiddenSurfaces: string[]) =>
      unwrap(
        api.PUT("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
          body: { hiddenSurfaces },
        })
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const toggle = (path: string, show: boolean) => {
    const next = show
      ? [...hidden].filter((p) => p !== path)
      : [...hidden, path];
    update.mutate(next);
  };

  return {
    hidden,
    toggle,
    isPending: update.isPending,
    loaded: prefs.isSuccess,
  };
}

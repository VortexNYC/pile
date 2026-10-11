import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

export interface Favorite {
  type: "issue" | "document";
  id: string;
  title: string;
  identifier?: string | null;
  addedAt: string;
}

/** Per-user starred items — pinned to the sidebar. Stored in
 * user_workspace_preferences.favorites (server round-trips the
 * whole list; we just patch and PUT). */
export function useFavorites(organizationId: string) {
  const queryClient = useQueryClient();
  const key = wsKey(organizationId, "view-preferences");
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
        })
      ),
  });
  const favorites = query.data?.favorites ?? [];

  const set = useMutation({
    mutationFn: async (next: Favorite[]) =>
      unwrap(
        api.PUT("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
          body: { favorites: next },
        })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const isFavorite = (type: Favorite["type"], id: string) =>
    favorites.some((f) => f.type === type && f.id === id);

  const toggle = (fav: Omit<Favorite, "addedAt">) => {
    const next = isFavorite(fav.type, fav.id)
      ? favorites.filter((f) => !(f.type === fav.type && f.id === fav.id))
      : [...favorites, { ...fav, addedAt: new Date().toISOString() }];
    set.mutate(next);
  };

  return { favorites, isFavorite, toggle, isPending: set.isPending };
}

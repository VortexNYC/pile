import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

export type SurfaceDensity = "comfortable" | "compact";

/** Per-surface look-and-feel prefs — Sheets-style controls for the CRM
 * list: sheet-tab colors, row density, and hidden columns. */
export interface SurfaceDisplayPrefs {
  sheetColors?: Record<string, string>;
  density?: SurfaceDensity;
  hiddenColumns?: string[];
}

export type DisplayPrefsMap = Record<string, SurfaceDisplayPrefs>;

/** Shallow-merge a patch into one surface's prefs without touching any
 * other surface — the PUT replaces the whole map, so callers merge
 * against the last-known value. */
export function mergeDisplayPreferences(
  existing: DisplayPrefsMap | null | undefined,
  surface: string,
  patch: SurfaceDisplayPrefs
): DisplayPrefsMap {
  return {
    ...existing,
    [surface]: { ...existing?.[surface], ...patch },
  };
}

/** Reads `display[surface]` from me/view-preferences and PUTs the merged
 * map on every change — never clobbers favorites or hiddenSurfaces, which
 * live on the same preferences row. */
export function useDisplayPrefs(organizationId: string, surface: string) {
  const queryClient = useQueryClient();
  const key = wsKey(organizationId, "view-preferences");

  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
        })
      ),
  });

  const all: DisplayPrefsMap = query.data?.display ?? {};
  const prefs = all[surface] ?? {};

  const update = useMutation({
    mutationFn: (patch: SurfaceDisplayPrefs) =>
      unwrap(
        api.PUT("/workspaces/{organizationId}/me/view-preferences", {
          params: { path: { organizationId } },
          body: { display: mergeDisplayPreferences(all, surface, patch) },
        })
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const setSheetColor = (sheetKey: string, color: string | null) => {
    const sheetColors = { ...prefs.sheetColors };
    if (color === null) {
      delete sheetColors[sheetKey];
    } else {
      sheetColors[sheetKey] = color;
    }
    update.mutate({ sheetColors });
  };

  const clearSheetColors = () => {
    update.mutate({ sheetColors: {} });
  };

  const setDensity = (density: SurfaceDensity) => {
    update.mutate({ density });
  };

  const toggleColumn = (column: string) => {
    const hidden = new Set(prefs.hiddenColumns ?? []);
    if (hidden.has(column)) {
      hidden.delete(column);
    } else {
      hidden.add(column);
    }
    update.mutate({ hiddenColumns: [...hidden] });
  };

  return {
    prefs,
    setSheetColor,
    clearSheetColors,
    setDensity,
    toggleColumn,
    isPending: update.isPending,
    loaded: query.isSuccess,
  };
}

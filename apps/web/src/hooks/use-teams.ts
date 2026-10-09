import { queryOptions, useQuery } from "@tanstack/react-query";

import { api, unwrap } from "@/lib/api";

import { wsKey } from "./use-workspace";

export const teamsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: wsKey(workspaceId, "teams"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/teams", {
            params: { path: { organizationId: workspaceId } },
          })
        )
      ).teams,
  });

export function useTeams(workspaceId: string) {
  return useQuery(teamsQuery(workspaceId));
}

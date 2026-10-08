import { queryOptions, useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { api, unwrap, type paths } from "@/lib/api";

export type Workspace =
  paths["/workspaces"]["get"]["responses"][200]["content"]["application/json"]["workspaces"][number];

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: async () => (await unwrap(api.GET("/workspaces"))).workspaces,
});

export function useWorkspaces() {
  return useQuery(workspacesQuery);
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === null) {
    throw new Error("useWorkspace must be used inside a workspace route");
  }
  return workspace;
}

/** Query keys are scoped by workspace id so cached rows never cross workspaces. */
export function wsKey(workspaceId: string, ...parts: unknown[]) {
  return ["ws", workspaceId, ...parts] as const;
}

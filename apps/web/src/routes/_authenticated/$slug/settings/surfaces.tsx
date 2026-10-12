import { Switch } from "@cloudflare/kumo/components/switch";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { LoadingState } from "@/components/states";
import { useSurfaces } from "@/hooks/use-surfaces";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";

export const Route = createFileRoute("/_authenticated/$slug/settings/surfaces")(
  {
    component: Surfaces,
  }
);

/** Every navigation surface — toggle off what you never read. Cycles,
 * initiatives and roadmaps start hidden and can be switched on. */
const SURFACES = [
  { path: "", label: "Overview" },
  { path: "issues", label: "Issues" },
  { path: "sessions", label: "Sessions" },
  { path: "projects", label: "Projects" },
  { path: "documents", label: "Documents" },
  { path: "tickets", label: "Support" },
  { path: "customers", label: "Customers" },
  { path: "changelog", label: "Changelog" },
  { path: "cycles", label: "Cycles" },
  { path: "initiatives", label: "Initiatives" },
  { path: "roadmaps", label: "Roadmaps" },
] as const;

function Surfaces() {
  const workspace = useWorkspace();
  const surfaces = useSurfaces(workspace.id);
  const queryClient = useQueryClient();

  return (
    <Page
      title="Surfaces"
      description="Choose what appears in the workspace sidebar. Hidden sections are still reachable by URL."
    >
      {!surfaces.loaded ? (
        <LoadingState label="Loading surfaces" />
      ) : (
        <div className="flex flex-col gap-3">
          {SURFACES.map((s) => (
            <Switch
              key={s.path}
              label={s.label}
              checked={!surfaces.hidden.has(s.path)}
              disabled={surfaces.isPending}
              onCheckedChange={(checked) => {
                surfaces.toggle(s.path, checked);
                void queryClient.invalidateQueries({
                  queryKey: wsKey(workspace.id, "view-preferences"),
                });
              }}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

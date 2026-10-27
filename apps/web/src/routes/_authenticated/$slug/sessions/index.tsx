import { Select } from "@cloudflare/kumo/components/select";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { SessionsList, useAgentSessions } from "@/components/sessions-list";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

interface SessionsSearch {
  agent?: string;
}

export const Route = createFileRoute("/_authenticated/$slug/sessions/")({
  component: Sessions,
  validateSearch: (search: Record<string, unknown>): SessionsSearch => ({
    agent:
      typeof search.agent === "string" && search.agent.length > 0
        ? search.agent
        : undefined,
  }),
});

/** Filter options: every registered agent type plus any agentId that
 * actually has lanes, deduped and sorted (PILE-453). An agentId a type
 * already covers (its slug or providerAgentId) is dropped — picking the
 * type resolves to the same lanes, and a second option would render the
 * same label. */
export function agentFilterOptions(
  agentTypes: readonly { slug: string; providerAgentId: string }[],
  agentIds: readonly string[],
  /** The value in the URL — kept as an option even when no lane or type
   * covers it, so a stale/bookmarked filter stays visible. */
  active?: string
): string[] {
  const covered = new Set(
    agentTypes.flatMap((t) => [t.slug, t.providerAgentId])
  );
  return [
    ...new Set([
      ...agentTypes.map((t) => t.slug),
      ...agentIds.filter((id) => !covered.has(id)),
      ...(active ? [active] : []),
    ]),
  ].toSorted();
}

/** Display name per scope key — both the type slug and the providerAgentId
 * pipeline lanes record resolve to the type's name. */
export function agentGroupLabels(
  agentTypes: readonly {
    slug: string;
    name: string;
    providerAgentId: string;
  }[]
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const t of agentTypes) {
    labels[t.slug] = t.name;
    labels[t.providerAgentId] ??= t.name;
  }
  return labels;
}

function Sessions() {
  const workspace = useWorkspace();
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();

  const agentTypes = useQuery({
    queryKey: wsKey(workspace.id, "agent-types"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/agent-types", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).agentTypes,
  });
  // Shares the unscoped query the list below runs — the picker offers
  // every agent that actually has lanes, plus registered types.
  const sessions = useAgentSessions();
  const options = agentFilterOptions(
    agentTypes.data ?? [],
    (sessions.data ?? []).map((s) => s.agentId),
    agent
  );
  const groupLabels = agentGroupLabels(agentTypes.data ?? []);

  return (
    <Page
      title="Sessions"
      description="Agent sessions across the workspace, grouped by agent."
    >
      <div className="mb-3 w-56">
        <Select
          aria-label="Filter sessions by agent"
          value={agent ?? "all"}
          onValueChange={(v) =>
            void navigate({
              search: { agent: !v || v === "all" ? undefined : v },
              replace: true,
            })
          }
        >
          <Select.Option value="all">All agents</Select.Option>
          {options.map((id) => (
            <Select.Option key={id} value={id}>
              {groupLabels[id] ?? id}
            </Select.Option>
          ))}
        </Select>
      </div>
      <SessionsList
        agentSlug={agent}
        groupBy="agent"
        groupLabels={groupLabels}
      />
    </Page>
  );
}

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
  const agentIds = (sessions.data ?? []).map((s) => s.agentId);
  const options = [
    ...new Set([...(agentTypes.data ?? []).map((t) => t.slug), ...agentIds]),
  ].toSorted();
  const groupLabels: Record<string, string> = {};
  for (const t of agentTypes.data ?? []) {
    groupLabels[t.slug] = t.name;
    groupLabels[t.providerAgentId] ??= t.name;
  }

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

import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

export const Route = createFileRoute("/_authenticated/$slug/settings/agents")({
  component: AgentsSettings,
});

const PROVIDERS = [
  ["grok", "Grok"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["custom", "Custom agent"],
] as const;

const PROVIDER_LABEL: Record<string, string> = Object.fromEntries(PROVIDERS);

function installSnippet(
  provider: string,
  key: string,
  workspaceId: string
): { title: string; body: string } {
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        pile: {
          url: "https://pile.nyc/mcp",
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2
  );
  switch (provider) {
    case "grok":
      return {
        title: "Paste into the bot's Pile settings",
        body: `Pile workspace API key\n${key}\n\nWorkspace\n${workspaceId}\n\nAPI base\nhttps://pile.nyc`,
      };
    case "claude":
      return {
        title:
          "Add .mcp.json to the repo (CLAUDE.md + .claude/skills already ship)",
        body: mcpConfig,
      };
    case "cursor":
      return {
        title: "Add .cursor/mcp.json to the repo",
        body: mcpConfig,
      };
    default:
      return {
        title: "Connect over MCP or REST",
        body: `MCP endpoint\nhttps://pile.nyc/mcp\nAuthorization: Bearer ${key}\n\nREST base\nhttps://pile.nyc/workspaces/${workspaceId}\nAuthorization: Bearer ${key}`,
      };
  }
}

function AgentsSettings() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState("grok");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read,write");
  const [allTeams, setAllTeams] = useState(true);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [installed, setInstalled] = useState<{
    name: string;
    provider: string;
    token: string;
  } | null>(null);

  const teams = useQuery({
    queryKey: wsKey(workspace.id, "teams"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/teams", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).teams,
  });

  const tokens = useQuery({
    queryKey: wsKey(workspace.id, "api-keys"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/tokens", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).tokens,
  });

  const install = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/tokens", {
          params: { path: { organizationId: workspace.id } },
          body: {
            name: name.trim() || PROVIDER_LABEL[provider] || "agent",
            actorType: "agent",
            provider,
            permissions: scope,
            ...(allTeams ? {} : { teamIds }),
          },
        })
      ),
    onSuccess: (data) => {
      if (data?.token) {
        setInstalled({
          name: name.trim() || PROVIDER_LABEL[provider] || "agent",
          provider,
          token: data.token,
        });
      }
      setName("");
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "api-keys"),
      });
    },
  });

  const revoke = useMutation({
    mutationFn: async (keyId: string) =>
      unwrap(
        api.DELETE("/workspaces/{organizationId}/tokens/{id}", {
          params: { path: { organizationId: workspace.id, id: keyId } },
        })
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "api-keys"),
      }),
  });

  if (!permissions.isLoaded) {
    return <LoadingState label="Checking access" />;
  }
  if (!permissions.isAdmin) {
    return (
      <Page title="Agents">
        <EmptyState
          title="Admins only"
          description="Installing agents is restricted to workspace admins."
        />
      </Page>
    );
  }

  const agents = (tokens.data ?? []).filter((t) => t.actorType === "agent");
  const teamList = teams.data ?? [];
  const snippet = installed
    ? installSnippet(installed.provider, installed.token, workspace.id)
    : null;

  return (
    <Page
      title="Agents"
      description="Install an agent as a workspace member — it gets its own identity, team access, and key. Same model as Linear's app actors."
    >
      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-4 p-5">
          <Text variant="heading" as="h2">
            Install agent
          </Text>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Provider
              </label>
              <Select
                aria-label="Provider"
                value={provider}
                onValueChange={(v) => v && setProvider(v)}
              >
                {PROVIDERS.map(([value, label]) => (
                  <Select.Option key={value} value={value}>
                    {label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <Input
              label="Name"
              placeholder={PROVIDER_LABEL[provider] ?? "agent name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Access
              </label>
              <Select
                aria-label="Access"
                value={scope}
                onValueChange={(v) => v && setScope(v)}
              >
                <Select.Option value="read">Read only</Select.Option>
                <Select.Option value="read,write">Read + write</Select.Option>
                <Select.Option value="admin">Admin</Select.Option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Teams
              </label>
              <Select
                aria-label="Teams"
                value={allTeams ? "all" : "specific"}
                onValueChange={(v) => v && setAllTeams(v === "all")}
              >
                <Select.Option value="all">All teams</Select.Option>
                <Select.Option value="specific">Specific teams</Select.Option>
              </Select>
            </div>
          </div>
          {!allTeams ? (
            <Checkbox.Group
              legend="Agent can access"
              value={teamIds}
              onValueChange={(v) => setTeamIds(v)}
            >
              {teamList.map((t) => (
                <Checkbox.Item key={t.id} value={t.id} label={t.name} />
              ))}
            </Checkbox.Group>
          ) : null}
          <div>
            <Button
              variant="primary"
              loading={install.isPending}
              onClick={() => install.mutate()}
            >
              Install agent
            </Button>
          </div>
          {install.isError ? (
            <Text variant="error" size="sm">
              {install.error.message}
            </Text>
          ) : null}
          {installed && snippet ? (
            <div className="flex flex-col gap-3 rounded border border-kumo-line p-4">
              <Text variant="heading" as="h3">
                {installed.name} installed — key shown once
              </Text>
              <ClipboardText text={installed.token} />
              <Text variant="secondary" size="sm">
                {snippet.title}
              </Text>
              <pre className="overflow-x-auto rounded bg-kumo-overlay p-3 text-xs whitespace-pre-wrap">
                {snippet.body}
              </pre>
            </div>
          ) : null}
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-3 p-5">
          <Text variant="heading" as="h2">
            Installed agents
          </Text>
          {tokens.isError ? (
            <ErrorState
              error={tokens.error}
              onRetry={() => void tokens.refetch()}
            />
          ) : agents.length === 0 ? (
            <EmptyState
              title="No agents installed"
              description="Install Grok, Claude, or Cursor above — each gets its own member identity."
            />
          ) : (
            agents.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between border-b border-kumo-line py-2 last:border-0"
              >
                <div className="flex flex-col">
                  <Text>{t.name}</Text>
                  <Text variant="secondary" size="sm">
                    {t.provider ?? "custom"} · {t.permissions} ·{" "}
                    {t.teamIds?.length ?? 0} teams
                  </Text>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => revoke.mutate(t.id)}
                  loading={revoke.isPending}
                >
                  Revoke
                </Button>
              </div>
            ))
          )}
        </LayerCard.Primary>
      </LayerCard>
    </Page>
  );
}

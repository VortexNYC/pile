import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

export const Route = createFileRoute(
  "/_authenticated/$slug/settings/developer"
)({
  component: DeveloperSettings,
});

interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
}

function DeveloperSettings() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: wsKey(workspace.id, "api-keys"),
    queryFn: async () => {
      const { data, error } = await betterAuthClient.$fetch<{
        keys: ApiKeyRow[];
      }>("/api-key/list", { method: "GET" });
      if (error) throw new Error(error.message ?? "Failed to load API keys");
      return data.keys;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await betterAuthClient.apiKey.create({
        name: name.trim() || undefined,
      });
      if (error) throw new Error(error.message ?? "Failed to create key");
      return data;
    },
    onSuccess: (data) => {
      setCreatedKey(data?.key ?? null);
      setName("");
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "api-keys"),
      });
    },
  });

  const revoke = useMutation({
    mutationFn: async (keyId: string) => {
      const { error } = await betterAuthClient.apiKey.delete({ keyId });
      if (error) throw new Error(error.message ?? "Failed to delete key");
    },
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
      <Page title="Developer">
        <EmptyState
          title="Admins only"
          description="API keys are restricted to workspace admins."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Developer"
      description="API keys for the CLI, agents, and MCP. Keys are workspace-scoped."
    >
      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-4 p-5">
          <Text variant="heading" as="h2">
            New key
          </Text>
          <form
            className="flex items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending) create.mutate();
            }}
          >
            <Input
              label="Name"
              placeholder="e.g. my-laptop CLI"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create key
            </Button>
          </form>
          {create.isError ? (
            <Text variant="error" size="sm">
              {create.error.message}
            </Text>
          ) : null}
          {createdKey ? (
            <div className="flex flex-col gap-1">
              <Text variant="secondary" size="sm">
                Shown once — copy it now:
              </Text>
              <code className="bg-kumo-elevated text-kumo-default rounded-md px-3 py-2 font-mono text-sm break-all select-all">
                {createdKey}
              </code>
            </div>
          ) : null}
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-3 p-5">
          <Text variant="heading" as="h2">
            Existing keys
          </Text>
          {keys.isPending ? <LoadingState label="Loading keys" /> : null}
          {keys.isError ? (
            <ErrorState
              error={keys.error}
              onRetry={() => void keys.refetch()}
            />
          ) : null}
          {keys.data?.length === 0 ? (
            <EmptyState
              title="No API keys"
              description="Create one to use the Pile CLI or MCP server."
            />
          ) : null}
          <ul className="flex flex-col">
            {keys.data?.map((k) => (
              <li
                key={k.id}
                className="border-kumo-line flex items-center justify-between gap-4 border-b py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Text as="span" size="sm">
                    {k.name ?? k.start ?? k.id.slice(0, 8)}
                  </Text>
                  <Text variant="secondary" size="xs">
                    Created {new Date(k.createdAt).toLocaleDateString()}
                    {k.expiresAt
                      ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}`
                      : ""}
                    {k.enabled === false ? " · disabled" : ""}
                  </Text>
                </div>
                <Button
                  variant="secondary"
                  loading={revoke.isPending && revoke.variables === k.id}
                  onClick={() => revoke.mutate(k.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </LayerCard.Primary>
      </LayerCard>
    </Page>
  );
}

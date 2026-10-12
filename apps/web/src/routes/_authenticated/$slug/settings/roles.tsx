import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { EmptyState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/settings/roles")({
  component: Roles,
});

const BUILTIN = [
  { role: "owner", description: "Everything — owner-only verbs" },
  { role: "admin", description: "Everything — settings + member management" },
  { role: "member", description: "All content — no deletes or settings" },
  { role: "guest", description: "Documents only — shared docs, nothing else" },
] as const;

const RESOURCES = [
  "issue",
  "document",
  "project",
  "ticket",
  "contact",
  "customer",
  "deal",
  "session",
  "comment",
  "settings",
] as const;
const ACTIONS = ["view", "create", "edit", "delete"] as const;
type Resource = (typeof RESOURCES)[number];
type Action = (typeof ACTIONS)[number];

interface OrgRole {
  id: string;
  role: string;
  permission: string;
}

function Roles() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<Set<string>>(new Set());

  const roles = useQuery({
    queryKey: wsKey(workspace.id, "org-roles"),
    queryFn: async () => {
      const result = await betterAuthClient.$fetch(
        `/organization/list-roles?organizationId=${workspace.id}`
      );
      return (result.data ?? []) as OrgRole[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const permission: Record<string, string[]> = {};
      for (const grant of grants) {
        const [resource, action] = grant.split(":") as [string, string];
        permission[resource] = [...(permission[resource] ?? []), action];
      }
      const result = await betterAuthClient.$fetch(
        "/organization/create-role",
        {
          method: "POST",
          body: {
            organizationId: workspace.id,
            role: name.trim(),
            permission,
          },
        }
      );
      if (result.error) throw new Error(result.error.message ?? "Failed");
    },
    onSuccess: async () => {
      setName("");
      setGrants(new Set());
      toastSuccess("Role created");
      await queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "org-roles"),
      });
    },
    onError: (err: Error) => toastError(err.message),
  });

  const canManage = permissions.isAdmin;
  const toggle = (resource: Resource, action: Action) => {
    const key = `${resource}:${action}`;
    setGrants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Page title="Roles" description="Account types for this workspace.">
      <div className="flex flex-col gap-5">
        <LayerCard className="p-5">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Role</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head>Access</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {BUILTIN.map((r) => (
                <Table.Row key={r.role}>
                  <Table.Cell className="font-medium">{r.role}</Table.Cell>
                  <Table.Cell>
                    <Badge>Built-in</Badge>
                  </Table.Cell>
                  <Table.Cell className="text-kumo-mute">
                    {r.description}
                  </Table.Cell>
                </Table.Row>
              ))}
              {roles.isLoading ? (
                <Table.Row>
                  <Table.Cell colSpan={3}>
                    <LoadingState label="Loading roles" />
                  </Table.Cell>
                </Table.Row>
              ) : null}
              {roles.data?.map((r) => (
                <Table.Row key={r.id}>
                  <Table.Cell className="font-medium">{r.role}</Table.Cell>
                  <Table.Cell>
                    <Badge variant="secondary">Custom</Badge>
                  </Table.Cell>
                  <Table.Cell className="text-kumo-mute">
                    {Object.entries(
                      JSON.parse(r.permission) as Record<string, string[]>
                    )
                      .map(([res, actions]) => `${res}: ${actions.join(", ")}`)
                      .join(" · ")}
                  </Table.Cell>
                </Table.Row>
              ))}
              {roles.data?.length === 0 && roles.isSuccess ? (
                <Table.Row>
                  <Table.Cell colSpan={3}>
                    <EmptyState
                      title="No custom roles"
                      description="Create one below — invite members onto it."
                    />
                  </Table.Cell>
                </Table.Row>
              ) : null}
            </Table.Body>
          </Table>
        </LayerCard>

        {canManage ? (
          <LayerCard className="flex flex-col gap-4 p-5">
            <div className="text-sm font-semibold">New role</div>
            <Input
              placeholder="role-name (e.g. support, viewer)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Resource</Table.Head>
                  {ACTIONS.map((a) => (
                    <Table.Head key={a}>{a}</Table.Head>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {RESOURCES.map((res) => (
                  <Table.Row key={res}>
                    <Table.Cell className="font-medium">{res}</Table.Cell>
                    {ACTIONS.map((action) => (
                      <Table.Cell key={action}>
                        <Checkbox
                          checked={grants.has(`${res}:${action}`)}
                          onCheckedChange={() => toggle(res, action)}
                        />
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            <Button
              onClick={() => create.mutate()}
              disabled={
                create.isPending || name.trim() === "" || grants.size === 0
              }
            >
              Create role
            </Button>
          </LayerCard>
        ) : null}
      </div>
    </Page>
  );
}

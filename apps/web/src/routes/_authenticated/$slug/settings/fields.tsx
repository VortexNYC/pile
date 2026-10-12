import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import { Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/settings/fields")({
  component: Fields,
});

const ENTITY_TYPES = [
  ["issue", "Issues"],
  ["customer", "Customers"],
  ["deal", "Deals"],
] as const;
const FIELD_TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["select", "Select"],
  ["date", "Date"],
  ["boolean", "Boolean"],
] as const;

/** Custom field definitions — the "make it yours" layer. */
function Fields() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [entityType, setEntityType] = useState<string>("issue");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("text");
  const [options, setOptions] = useState("");
  const key = wsKey(workspace.id, "fields");

  const fields = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/fields", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).fields,
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/fields", {
          params: { path: { organizationId: workspace.id } },
          body: {
            entityType,
            name: name.trim(),
            type: type as never,
            options:
              type === "select"
                ? options
                    .split(",")
                    .map((o) => o.trim())
                    .filter(Boolean)
                : undefined,
          },
        })
      ),
    onSuccess: () => {
      setName("");
      setOptions("");
      setAdding(false);
      toastSuccess("Field added");
    },
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/workspaces/{organizationId}/fields/{fieldId}", {
          params: { path: { organizationId: workspace.id, fieldId: id } },
        })
      ),
    onSuccess: () => toastSuccess("Field removed"),
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <Page
      title="Custom fields"
      description="Fields your entities carry beyond the built-ins — defined here, edited on the entity."
      actions={
        <Button
          variant="primary"
          icon={<Plus />}
          onClick={() => setAdding(true)}
        >
          New field
        </Button>
      }
    >
      {adding ? (
        <LayerCard className="mb-4">
          <LayerCard.Primary className="p-4">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && !create.isPending) create.mutate();
              }}
            >
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-kumo-subtle">
                  Entity
                </label>
                <Select
                  aria-label="Entity type"
                  value={entityType}
                  onValueChange={(v) => v && setEntityType(v)}
                >
                  {ENTITY_TYPES.map(([value, label]) => (
                    <Select.Option key={value} value={value}>
                      {label}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <Input
                label="Name"
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-kumo-subtle">
                  Type
                </label>
                <Select
                  aria-label="Field type"
                  value={type}
                  onValueChange={(v) => v && setType(v)}
                >
                  {FIELD_TYPES.map(([value, label]) => (
                    <Select.Option key={value} value={value}>
                      {label}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              {type === "select" ? (
                <Input
                  label="Options (comma-separated)"
                  value={options}
                  required
                  placeholder="Gold, Silver"
                  onChange={(e) => setOptions(e.target.value)}
                />
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={create.isPending}
                  disabled={!name.trim()}
                >
                  Save field
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </LayerCard.Primary>
        </LayerCard>
      ) : null}
      {fields.isPending ? (
        <LoadingState label="Loading fields" />
      ) : fields.isError ? (
        <ErrorState
          error={fields.error}
          onRetry={() => void fields.refetch()}
        />
      ) : fields.data.length === 0 ? (
        <EmptyState
          title="No custom fields"
          description="Define fields per entity type — they'll show up in the detail rail."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Custom fields">
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>Entity</Table.Head>
                <Table.Head>Type</Table.Head>
                <Table.Head>Options</Table.Head>
                <Table.Head></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {fields.data.map((field) => (
                <Table.Row key={field.id}>
                  <Table.Cell className="font-medium text-kumo-default">
                    {field.name}
                  </Table.Cell>
                  <Table.Cell>{field.entityType}</Table.Cell>
                  <Table.Cell>
                    <Badge variant="neutral">{field.type}</Badge>
                  </Table.Cell>
                  <Table.Cell className="text-kumo-subtle text-sm">
                    {field.options?.join(", ") ?? "—"}
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash />}
                      aria-label={`Delete ${field.name}`}
                      onClick={() => remove.mutate(field.id)}
                    >
                      {""}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

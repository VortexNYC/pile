import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RailSection } from "@/components/entity-page";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";

/** The rail section for custom fields — defined in Settings → Fields,
 * edited here per entity. */
export function CustomFieldsRail({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: string;
}) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const defsKey = wsKey(workspace.id, "fields", { entityType });
  const valuesKey = wsKey(workspace.id, "fields", "values", entityId);

  const defs = useQuery({
    queryKey: defsKey,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/fields", {
            params: {
              path: { organizationId: workspace.id },
              query: { entityType },
            },
          })
        )
      ).fields,
  });

  const values = useQuery({
    queryKey: valuesKey,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/fields/values/{entityId}", {
            params: { path: { organizationId: workspace.id, entityId } },
          })
        )
      ).values,
  });

  const set = useMutation({
    mutationFn: (args: { fieldId: string; value: string | null }) =>
      unwrap(
        api.PUT("/workspaces/{organizationId}/fields/{fieldId}/value", {
          params: {
            path: { organizationId: workspace.id, fieldId: args.fieldId },
          },
          body: { entityId, value: args.value },
        })
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: valuesKey }),
  });

  const fields = defs.data ?? [];
  if (fields.length === 0 || defs.isPending) return null;

  const valueOf = (fieldId: string) =>
    values.data?.find((v) => v.fieldId === fieldId)?.value ?? null;

  return (
    <RailSection title="Custom fields">
      <div className="flex flex-col gap-2">
        {fields.map((field) => (
          <div key={field.id} className="flex flex-col gap-1">
            <label className="text-xs text-kumo-subtle">{field.name}</label>
            {field.type === "select" ? (
              <Select
                aria-label={field.name}
                value={valueOf(field.id) ?? ""}
                onValueChange={(v) =>
                  set.mutate({ fieldId: field.id, value: v || null })
                }
              >
                {(field.options ?? []).map((opt) => (
                  <Select.Option key={opt} value={opt}>
                    {opt}
                  </Select.Option>
                ))}
              </Select>
            ) : field.type === "boolean" ? (
              <Select
                aria-label={field.name}
                value={valueOf(field.id) ?? "false"}
                onValueChange={(v) =>
                  set.mutate({ fieldId: field.id, value: v })
                }
              >
                <Select.Option value="true">Yes</Select.Option>
                <Select.Option value="false">No</Select.Option>
              </Select>
            ) : (
              <input
                aria-label={field.name}
                type={
                  field.type === "number"
                    ? "number"
                    : field.type === "date"
                      ? "date"
                      : "text"
                }
                defaultValue={valueOf(field.id) ?? ""}
                onBlur={(e) =>
                  set.mutate({
                    fieldId: field.id,
                    value: e.target.value || null,
                  })
                }
                className="border-kumo-line bg-kumo-canvas h-8 rounded-md border px-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
              />
            )}
          </div>
        ))}
      </div>
    </RailSection>
  );
}

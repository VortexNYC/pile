import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Funnel } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";

import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import { PRIORITIES, PRIORITY_LABELS } from "@/lib/labels";

export interface IssueFilterState {
  priorities: string[];
  assignees: string[];
  projects: string[];
}

export const EMPTY_FILTER: IssueFilterState = {
  priorities: [],
  assignees: [],
  projects: [],
};

/** Linear's filter — one popover composing priority, assignee, and
 * project filters with an active-count badge. Applied client-side
 * over fetched rows (the API's filter params are single-valued). */
export function IssueFilter({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: IssueFilterState;
  onChange: (f: IssueFilterState) => void;
}) {
  const members = useQuery({
    queryKey: ["members", organizationId],
    queryFn: async () => {
      const res = await betterAuthClient.organization.listMembers({
        query: { organizationId },
      });
      return res.data?.members ?? [];
    },
  });
  const projects = useQuery({
    queryKey: ["projects", organizationId],
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/projects", {
            params: { path: { organizationId } },
          })
        )
      ).projects,
  });

  const active =
    value.priorities.length + value.assignees.length + value.projects.length;

  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="ghost" icon={<Funnel />}>
            Filter
            {active > 0 ? (
              <span className="bg-kumo-brand text-kumo-contrast ml-1 rounded-full px-1.5 text-xs">
                {active}
              </span>
            ) : null}
          </Button>
        }
      />
      <Popover.Content className="w-64 max-h-96 overflow-auto p-3">
        <div className="flex flex-col gap-4">
          <Checkbox.Group
            legend="Priority"
            value={value.priorities}
            onValueChange={(v) => onChange({ ...value, priorities: v })}
          >
            {PRIORITIES.map((p) => (
              <Checkbox.Item key={p} value={p} label={PRIORITY_LABELS[p]} />
            ))}
          </Checkbox.Group>
          {(members.data?.length ?? 0) > 0 ? (
            <Checkbox.Group
              legend="Assignee"
              value={value.assignees}
              onValueChange={(v) => onChange({ ...value, assignees: v })}
            >
              {(members.data ?? []).map((m) => (
                <Checkbox.Item
                  key={m.userId}
                  value={m.userId}
                  label={m.user?.name ?? m.user?.email ?? m.userId.slice(0, 8)}
                />
              ))}
            </Checkbox.Group>
          ) : null}
          {(projects.data?.length ?? 0) > 0 ? (
            <Checkbox.Group
              legend="Project"
              value={value.projects}
              onValueChange={(v) => onChange({ ...value, projects: v })}
            >
              {(projects.data ?? []).map((p) => (
                <Checkbox.Item key={p.id} value={p.id} label={p.name} />
              ))}
            </Checkbox.Group>
          ) : null}
          {active > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(EMPTY_FILTER)}
            >
              Clear all
            </Button>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}

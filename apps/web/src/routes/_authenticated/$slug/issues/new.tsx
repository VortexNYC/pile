import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { IssueForm } from "@/components/issue-form";
import { Page } from "@/components/page";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/issues/new")({
  component: NewIssue,
});

function NewIssue() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: (values: {
      title: string;
      description: string;
      status:
        | "triage"
        | "backlog"
        | "todo"
        | "in_progress"
        | "done"
        | "canceled";
      priority: "low" | "medium" | "high" | "urgent";
    }) =>
      unwrap(
        api.POST("/workspaces/{organizationId}/issues", {
          params: { path: { organizationId: workspace.id } },
          body: {
            title: values.title,
            description: values.description.trim() || undefined,
            status: values.status,
            priority: values.priority,
          },
        })
      ),
    onSuccess: async (issue) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "issues"),
      });
      toastSuccess("Issue created");
      await navigate({
        to: "/$slug/issues/$issueId",
        params: { slug: workspace.slug, issueId: issue.id },
      });
    },
    onError: (error) => toastError(error),
  });

  const back = () =>
    void navigate({ to: "/$slug/issues", params: { slug: workspace.slug } });

  return (
    <Page title="New issue">
      <LayerCard>
        <LayerCard.Primary className="p-6">
          <IssueForm
            initial={{
              title: "",
              description: "",
              status: "todo",
              priority: "medium",
            }}
            submitLabel="Create issue"
            pending={create.isPending}
            onSubmit={(values) => create.mutate(values)}
            onCancel={back}
          />
        </LayerCard.Primary>
      </LayerCard>
    </Page>
  );
}

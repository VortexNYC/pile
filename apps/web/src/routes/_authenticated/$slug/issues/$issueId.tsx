import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { IssueComments } from "@/components/comments";
import { IssueForm, type IssueFormValues } from "@/components/issue-form";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import {
  formatRelative,
  ISSUE_STATUS_LABELS,
  issueStatusVariant,
  PRIORITY_LABELS,
  priorityVariant,
} from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/issues/$issueId")({
  component: IssueDetail,
});

function IssueDetail() {
  const { issueId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const key = wsKey(organizationId, "issues", issueId);
  const path = { organizationId, id: issueId };

  const issue = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
        })
      ),
  });

  const save = useMutation({
    mutationFn: (values: IssueFormValues) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
          body: {
            title: values.title,
            description: values.description.trim() || null,
            status: values.status,
            priority: values.priority,
          },
        })
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "issues"),
      });
      setEditing(false);
      toastSuccess("Issue updated");
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/issues/{id}", {
          params: { path },
        })
      ),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "issues"),
      });
      toastSuccess("Issue deleted");
      await navigate({ to: "/$slug/issues", params: { slug: workspace.slug } });
    },
    onError: (error) => toastError(error),
  });

  if (issue.isPending) return <LoadingState label="Loading issue" />;
  if (issue.isError) {
    return (
      <Page title="Issue">
        <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />
      </Page>
    );
  }
  const data = issue.data;

  return (
    <Page
      title={data.title}
      description={
        <>
          <Link
            to="/$slug/issues"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Issues
          </Link>
          {data.identifier ? ` / ${data.identifier}` : null} · updated{" "}
          {formatRelative(data.updatedAt)}
        </>
      }
      actions={
        editing ? null : (
          <>
            <Button icon={<PencilSimple />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="secondary-destructive"
              icon={<Trash />}
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm("Delete this issue? This can't be undone."))
                  remove.mutate();
              }}
            >
              Delete
            </Button>
          </>
        )
      }
    >
      <LayerCard>
        <LayerCard.Primary className="flex flex-col gap-4 p-6">
          {editing ? (
            <IssueForm
              initial={{
                title: data.title,
                description: data.description ?? "",
                status: data.status,
                priority: data.priority,
              }}
              submitLabel="Save changes"
              pending={save.isPending}
              onSubmit={(values) => save.mutate(values)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div className="flex gap-2">
                <Badge variant={issueStatusVariant(data.status)}>
                  {ISSUE_STATUS_LABELS[data.status]}
                </Badge>
                <Badge variant={priorityVariant(data.priority)}>
                  {PRIORITY_LABELS[data.priority]} priority
                </Badge>
              </div>
              {data.description ? (
                <Text>
                  <span className="whitespace-pre-wrap">
                    {data.description}
                  </span>
                </Text>
              ) : (
                <Text variant="secondary">No description.</Text>
              )}
            </>
          )}
        </LayerCard.Primary>
      </LayerCard>
      <IssueComments issueId={issueId} />
    </Page>
  );
}

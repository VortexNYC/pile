import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { PencilSimple, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  DocumentForm,
  type DocumentFormValues,
} from "@/components/document-form";
import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { documentText, formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute(
  "/_authenticated/$slug/documents/$documentId"
)({
  component: DocumentDetail,
});

function DocumentDetail() {
  const { documentId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const key = wsKey(organizationId, "documents", documentId);
  const path = { organizationId, id: documentId };

  const doc = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
        })
      ),
  });

  const save = useMutation({
    mutationFn: (values: DocumentFormValues) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
          body: {
            title: values.title,
            content: values.content,
            contentFormat: "markdown",
          },
        })
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "documents"),
      });
      setEditing(false);
      toastSuccess("Document saved");
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
        })
      ),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "documents"),
      });
      toastSuccess("Document deleted");
      await navigate({
        to: "/$slug/documents",
        params: { slug: workspace.slug },
      });
    },
    onError: (error) => toastError(error),
  });

  if (doc.isPending) return <LoadingState label="Loading document" />;
  if (doc.isError) {
    return (
      <Page title="Document">
        <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />
      </Page>
    );
  }
  const data = doc.data;
  const text = documentText(data.content);
  const backlinks = useQuery({
    queryKey: wsKey(organizationId, "documents", documentId, "backlinks"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents/{id}/backlinks", {
            params: { path: { organizationId, id: documentId } },
          })
        )
      ).documents,
  });
  const allDocs = useQuery({
    queryKey: wsKey(organizationId, "documents"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: { path: { organizationId } },
          })
        )
      ).documents,
    enabled: (backlinks.data?.length ?? 0) > 0,
  });
  const backlinkRows = (backlinks.data ?? []).map((id) => ({
    id,
    title:
      allDocs.data?.find((d) => d.id === id)?.title ??
      `Document ${id.slice(0, 8)}`,
  }));

  return (
    <Page
      title={data.title}
      description={
        <>
          <Link
            to="/$slug/documents"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Documents
          </Link>{" "}
          · updated {formatRelative(data.updatedAt)}
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
                if (window.confirm("Move this document to trash?"))
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
        <LayerCard.Primary className="p-6">
          {editing ? (
            <DocumentForm
              initial={{ title: data.title, content: text }}
              submitLabel="Save"
              pending={save.isPending}
              onSubmit={(values) => save.mutate(values)}
              onCancel={() => setEditing(false)}
            />
          ) : text ? (
            <Markdown workspaceSlug={workspace.slug} content={text} />
          ) : (
            <Text variant="secondary">This document is empty.</Text>
          )}
        </LayerCard.Primary>
      </LayerCard>
      {backlinkRows.length > 0 ? (
        <LayerCard>
          <div className="border-b border-kumo-line px-4 py-3">
            <Text variant="secondary">Linked from</Text>
          </div>
          <ul className="px-4 py-3 flex flex-col gap-1.5">
            {backlinkRows.map((b) => (
              <li key={b.id}>
                <Link
                  to="/$slug/documents/$documentId"
                  params={{ slug: workspace.slug, documentId: b.id }}
                  className="text-kumo-link hover:underline"
                >
                  {b.title}
                </Link>
              </li>
            ))}
          </ul>
        </LayerCard>
      ) : null}
    </Page>
  );
}

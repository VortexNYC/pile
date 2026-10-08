import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  DocumentForm,
  type DocumentFormValues,
} from "@/components/document-form";
import { Page } from "@/components/page";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/documents/new")({
  component: NewDocument,
});

function NewDocument() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (values: DocumentFormValues) =>
      unwrap(
        api.POST("/workspaces/{organizationId}/documents", {
          params: { path: { organizationId: workspace.id } },
          body: {
            title: values.title,
            content: values.content,
            contentFormat: "markdown",
          },
        })
      ),
    onSuccess: async (doc) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "documents"),
      });
      toastSuccess("Document created");
      await navigate({
        to: "/$slug/documents/$documentId",
        params: { slug: workspace.slug, documentId: doc.id },
      });
    },
    onError: (error) => toastError(error),
  });
  return (
    <Page title="New document">
      <LayerCard>
        <LayerCard.Primary className="p-6">
          <DocumentForm
            initial={{ title: "", content: "" }}
            submitLabel="Create document"
            pending={create.isPending}
            onSubmit={(values) => create.mutate(values)}
            onCancel={() =>
              void navigate({
                to: "/$slug/documents",
                params: { slug: workspace.slug },
              })
            }
          />
        </LayerCard.Primary>
      </LayerCard>
    </Page>
  );
}

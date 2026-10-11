import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { FileText, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/$slug/documents/")({
  component: DocumentsList,
});

function DocumentsList() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const documents = useQuery({
    queryKey: wsKey(workspace.id, "documents"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).documents.filter((d) => !d.isTemplate),
  });
  const createCanvas = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/documents", {
          params: { path: { organizationId: workspace.id } },
          body: {
            title: "Untitled canvas",
            icon: "🎨",
            contentFormat: "canvas",
            content: "{}",
          },
        })
      ),
    onSuccess: (doc) => {
      void navigate({
        to: "/$slug/documents/$documentId",
        params: { slug: workspace.slug, documentId: doc.id },
      });
    },
  });
  const create = () =>
    void navigate({
      to: "/$slug/documents/new",
      params: { slug: workspace.slug },
    });

  return (
    <Page
      title="Documents"
      description="Notes, specs, and playbooks your team shares."
      actions={
        <div className="flex gap-2">
          <Button
            variant="ghost"
            icon={<Plus />}
            loading={createCanvas.isPending}
            onClick={() => createCanvas.mutate()}
          >
            New canvas
          </Button>
          <Button variant="primary" icon={<Plus />} onClick={create}>
            New document
          </Button>
        </div>
      }
    >
      {documents.isPending ? (
        <LoadingState label="Loading documents" />
      ) : documents.isError ? (
        <ErrorState
          error={documents.error}
          onRetry={() => void documents.refetch()}
        />
      ) : documents.data.length === 0 ? (
        <EmptyState
          icon={<FileText size={40} />}
          title="No documents yet"
          description="Write the first one for your team."
        />
      ) : (
        <LayerCard className="p-0">
          <Table aria-label="Documents">
            <Table.Header>
              <Table.Row>
                <Table.Head>Title</Table.Head>
                <Table.Head>Updated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {documents.data.map((doc) => (
                <Table.Row key={doc.id}>
                  <Table.Cell>
                    <Link
                      to="/$slug/documents/$documentId"
                      params={{ slug: workspace.slug, documentId: doc.id }}
                      className="text-kumo-link hover:underline"
                    >
                      {doc.icon ? `${doc.icon} ` : ""}
                      {doc.title}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>{formatRelative(doc.updatedAt)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Page>
  );
}

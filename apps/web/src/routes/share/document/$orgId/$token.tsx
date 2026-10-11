import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Markdown } from "@/components/markdown";
import { ShareShell } from "@/components/share-view";
import { api, unwrap } from "@/lib/api";
import { documentText } from "@/lib/labels";

export const Route = createFileRoute("/share/document/$orgId/$token")({
  component: SharedDocument,
});

function SharedDocument() {
  const { orgId, token } = Route.useParams();
  const doc = useQuery({
    queryKey: ["shared-document", orgId, token],
    queryFn: async () =>
      unwrap(
        api.GET("/shared-documents/{organizationId}/{token}", {
          params: { path: { organizationId: orgId, token } },
        })
      ),
    retry: false,
  });
  const data = doc.data?.document;

  return (
    <ShareShell
      eyebrow="Shared document"
      title={data?.title ?? "Document"}
      pending={doc.isPending}
      error={doc.error}
    >
      {data ? <Markdown content={documentText(data.content)} /> : null}
      {doc.data?.children?.map((child) => (
        <div key={child.id} className="border-t border-kumo-line pt-4 mt-4">
          <h2 className="text-lg font-semibold text-kumo-default mb-2">
            {child.title}
          </h2>
          <Markdown content={documentText(child.content)} />
        </div>
      ))}
    </ShareShell>
  );
}

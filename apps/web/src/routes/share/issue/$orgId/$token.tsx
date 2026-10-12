import { Badge } from "@cloudflare/kumo/components/badge";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Markdown } from "@/components/markdown";
import { ShareShell } from "@/components/share-view";
import { api, unwrap } from "@/lib/api";

export const Route = createFileRoute("/share/issue/$orgId/$token")({
  component: SharedIssue,
});

function SharedIssue() {
  const { orgId, token } = Route.useParams();
  const issue = useQuery({
    queryKey: ["shared-issue", orgId, token],
    queryFn: async () =>
      unwrap(
        api.GET("/shared-issues/{organizationId}/{token}", {
          params: { path: { organizationId: orgId, token } },
        })
      ),
    retry: false,
  });
  const data = issue.data?.issue;

  return (
    <ShareShell
      eyebrow="Shared issue"
      title={data ? `${data.identifier ?? ""} ${data.title}`.trim() : "Issue"}
      pending={issue.isPending}
      error={issue.error}
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{data?.status}</Badge>
        <Badge variant="secondary">{data?.priority}</Badge>
      </div>
      {data?.description ? (
        <Markdown content={data.description} />
      ) : (
        <p className="text-sm text-kumo-subtle">No description.</p>
      )}
    </ShareShell>
  );
}

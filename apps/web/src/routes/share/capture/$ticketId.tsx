import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ShareShell } from "@/components/share-view";
import { TechnicalPanel } from "@/components/technical-panel";
import { api, unwrap } from "@/lib/api";

export const Route = createFileRoute("/share/capture/$ticketId")({
  component: SharedCapture,
});

function SharedCapture() {
  const { ticketId } = Route.useParams();
  const capture = useQuery({
    queryKey: ["shared-capture", ticketId],
    queryFn: async () =>
      unwrap(
        api.GET("/support/capture/public/{ticketId}", {
          params: { path: { ticketId } },
        })
      ),
    retry: false,
  });
  const data = capture.data;

  return (
    <ShareShell
      eyebrow="Shared capture"
      title={data?.title ?? "Capture"}
      pending={capture.isPending}
      error={capture.error}
    >
      <div className="flex flex-col gap-4">
        <TechnicalPanel attachments={data?.attachments ?? []} />
        {data?.attachments.map((attachment) => {
          if (attachment.type === "video" && attachment.url) {
            return (
              <video
                key={attachment.url}
                controls
                src={attachment.url}
                className="w-full rounded-lg border border-kumo-line"
              />
            );
          }
          if (attachment.type === "screenshot" && attachment.url) {
            return (
              <img
                key={attachment.url}
                src={attachment.url}
                alt={data.title}
                className="w-full rounded-lg border border-kumo-line"
              />
            );
          }
          return attachment.url ? (
            <a
              key={attachment.url}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-kumo-link hover:underline"
            >
              {attachment.type} ↗
            </a>
          ) : null;
        })}
      </div>
    </ShareShell>
  );
}

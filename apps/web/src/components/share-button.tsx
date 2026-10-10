import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Share, X } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api, unwrap } from "@/lib/api";

/** Create a public share link for an entity and surface the URL to
 * copy. Renders `/app/share/{kind}/...` public viewers (unauthenticated). */
export function ShareButton({
  organizationId,
  kind,
  id,
}: {
  organizationId: string;
  kind: "issue" | "document";
  id: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const share = useMutation({
    mutationFn: async () => {
      const res =
        kind === "issue"
          ? await unwrap(
              api.POST(
                "/workspaces/{organizationId}/issues/{id}/share",
                {
                  params: { path: { organizationId, id } },
                  body: {},
                }
              )
            )
          : await unwrap(
              api.POST(
                "/workspaces/{organizationId}/documents/{id}/share",
                {
                  params: { path: { organizationId, id } },
                  body: {},
                }
              )
            );
      return res;
    },
    onSuccess: (data) => {
      setUrl(
        `${window.location.origin}/app/share/${kind}/${organizationId}/${data.token}`
      );
    },
  });

  if (url) {
    return (
      <LayerCard className="flex items-center gap-2 p-2 pl-3 max-w-md">
        <code className="flex-1 truncate text-xs text-kumo-default">{url}</code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigator.clipboard.writeText(url)}
        >
          Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => setUrl(null)}
        >
          <X />
        </Button>
      </LayerCard>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={share.isPending}
      onClick={() => share.mutate()}
    >
      <Share /> Share
    </Button>
  );
}

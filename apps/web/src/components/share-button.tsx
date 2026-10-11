import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Share, Trash, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { toastSuccess } from "@/lib/toast";

/** Share management — shows the entity's active public link with
 * copy/revoke, or a Share button to mint one. The token is the
 * capability; revoking kills the link. */
export function ShareButton({
  organizationId,
  kind,
  id,
}: {
  organizationId: string;
  kind: "issue" | "document";
  id: string;
}) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const key = ["share", kind, organizationId, id];
  const getPath =
    kind === "issue"
      ? "/workspaces/{organizationId}/issues/{id}/share"
      : "/workspaces/{organizationId}/documents/{id}/share";

  const existing = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        api.GET(getPath, {
          params: { path: { organizationId, id } },
        })
      ),
  });

  const share = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST(getPath, {
          params: { path: { organizationId, id } },
          body: {},
        })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const revoke = useMutation({
    mutationFn: async (token: string) =>
      unwrapEmpty(
        api.DELETE(
          kind === "issue"
            ? "/workspaces/{organizationId}/issues/{id}/share/{token}"
            : "/workspaces/{organizationId}/documents/{id}/share/{token}",
          { params: { path: { organizationId, id, token } } }
        )
      ),
    onSuccess: () => {
      toastSuccess("Share revoked");
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const active = existing.data;
  const url = active
    ? `${window.location.origin}/app/share/${kind}/${organizationId}/${active.token}`
    : null;

  if (url && !dismissed) {
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
          aria-label="Revoke share"
          loading={revoke.isPending}
          onClick={() => {
            if (window.confirm("Revoke this share link?")) {
              revoke.mutate(active!.token);
            }
          }}
        >
          <Trash />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
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
      onClick={() => {
        setDismissed(false);
        share.mutate();
      }}
    >
      <Share /> Share
    </Button>
  );
}

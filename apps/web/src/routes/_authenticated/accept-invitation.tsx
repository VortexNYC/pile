import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { workspacesQuery } from "@/hooks/use-workspace";
import { betterAuthClient } from "@/lib/better-auth";

export const Route = createFileRoute("/_authenticated/accept-invitation")({
  component: AcceptInvitation,
  validateSearch: (search: Record<string, unknown>): { id?: string } => ({
    id: typeof search.id === "string" && search.id ? search.id : undefined,
  }),
});

function AcceptInvitation() {
  const { id } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const accept = useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await betterAuthClient.organization.acceptInvitation({
        invitationId,
      });
      if (result.error) {
        throw new Error(
          result.error.message ?? "This invitation couldn't be accepted."
        );
      }
      return result.data?.member.organizationId ?? null;
    },
    onSuccess: async (organizationId) => {
      await queryClient.invalidateQueries({
        queryKey: workspacesQuery.queryKey,
      });
      const workspaces = await queryClient.fetchQuery(workspacesQuery);
      const joined = workspaces.find((w) => w.id === organizationId);
      await (joined
        ? navigate({ to: "/$slug/issues", params: { slug: joined.slug } })
        : navigate({ to: "/" }));
    },
  });

  return (
    <div className="bg-kumo-canvas flex min-h-dvh items-center justify-center px-4">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Primary className="flex flex-col gap-4 p-6">
          <Text variant="heading" as="h1" size="lg">
            Join workspace
          </Text>
          {id ? (
            <>
              <Text variant="secondary" size="sm">
                You've been invited to a workspace. Accept to join it.
              </Text>
              {accept.isError ? (
                <Text variant="error" size="sm">
                  {accept.error.message}
                </Text>
              ) : null}
              <Button
                variant="primary"
                loading={accept.isPending}
                onClick={() => accept.mutate(id)}
              >
                Accept invitation
              </Button>
            </>
          ) : (
            <Text variant="error" size="sm">
              This invitation link is missing its id.
            </Text>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}

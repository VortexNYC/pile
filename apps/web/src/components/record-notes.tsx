import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { Composer, type MentionTarget } from "@/components/composer";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import { formatRelative } from "@/lib/labels";
import { toastError } from "@/lib/toast";

type RecordEntity = "customer" | "deal" | "contact";

/** Attio-style record notes — comment threads on CRM entities. Same
 * comments table issues/documents share, scoped by entityType+entityId. */
export function RecordNotes({
  entityType,
  entityId,
  members,
}: {
  entityType: RecordEntity;
  entityId: string;
  members?: MentionTarget[];
}) {
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const { data: session } = betterAuthClient.useSession();
  const key = wsKey(organizationId, "notes", entityType, entityId);

  const list = (orgId: string, id: string) => {
    if (entityType === "customer") {
      return api.GET("/workspaces/{organizationId}/customers/{id}/comments", {
        params: { path: { organizationId: orgId, id } },
      });
    }
    if (entityType === "deal") {
      return api.GET("/workspaces/{organizationId}/deals/{dealId}/comments", {
        params: { path: { organizationId: orgId, dealId: id } },
      });
    }
    return api.GET(
      "/workspaces/{organizationId}/support/customers/{customerId}/comments",
      { params: { path: { organizationId: orgId, customerId: id } } }
    );
  };
  const create = (orgId: string, id: string, body: string) => {
    const json = { body };
    if (entityType === "customer") {
      return api.POST("/workspaces/{organizationId}/customers/{id}/comments", {
        params: { path: { organizationId: orgId, id } },
        body: json,
      });
    }
    if (entityType === "deal") {
      return api.POST("/workspaces/{organizationId}/deals/{dealId}/comments", {
        params: { path: { organizationId: orgId, dealId: id } },
        body: json,
      });
    }
    return api.POST(
      "/workspaces/{organizationId}/support/customers/{customerId}/comments",
      {
        params: { path: { organizationId: orgId, customerId: id } },
        body: json,
      }
    );
  };

  const comments = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await unwrap(list(organizationId, entityId))).comments,
  });

  const sorted = useMemo(
    () =>
      (comments.data ?? [])
        .slice()
        .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [comments.data]
  );

  const post = useMutation({
    mutationFn: (body: string) =>
      unwrap(create(organizationId, entityId, body)),
    onError: (error) => toastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <section aria-label="Notes" className="flex flex-col gap-4">
      <Text variant="heading" as="h2">
        Notes
      </Text>
      {comments.isPending ? (
        <LoadingState label="Loading notes" />
      ) : comments.isError ? (
        <ErrorState
          error={comments.error}
          onRetry={() => void comments.refetch()}
        />
      ) : sorted.length === 0 ? (
        <Text variant="secondary" size="sm">
          No notes yet.
        </Text>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((comment) => (
            <li
              key={comment.id}
              className="border-kumo-hairline flex flex-col gap-2 rounded-lg border p-3"
            >
              <Text variant="secondary" size="xs">
                {session && comment.authorId === session.user.id
                  ? "You"
                  : (comment.externalAuthor ?? "Teammate")}{" "}
                · {formatRelative(comment.createdAt)}
              </Text>
              <p className="whitespace-pre-wrap text-sm text-kumo-default">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Composer
        placeholder="Add a note…"
        submitLabel="Add note"
        aria-label="Add a note"
        loading={post.isPending}
        onSubmit={(text) => post.mutate(text)}
        members={members}
      />
    </section>
  );
}

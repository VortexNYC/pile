import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Markdown } from "@/components/markdown";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { betterAuthClient } from "@/lib/better-auth";
import { formatRelative } from "@/lib/labels";
import { toastError } from "@/lib/toast";

export function IssueComments({ issueId }: { issueId: string }) {
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const { data: session } = betterAuthClient.useSession();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(
    null
  );
  const key = wsKey(organizationId, "issues", issueId, "comments");
  const path = { organizationId, issueId };

  const comments = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues/{issueId}/comments", {
            params: { path },
          })
        )
      ).comments,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const add = useMutation({
    mutationFn: (body: string) =>
      unwrap(
        api.POST("/workspaces/{organizationId}/issues/{issueId}/comments", {
          params: { path },
          body: { body },
        })
      ),
    onSuccess: () => setDraft(""),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      unwrap(
        api.PATCH(
          "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
          {
            params: { path: { ...path, id: input.id } },
            body: { body: input.body },
          }
        )
      ),
    onSuccess: () => setEditing(null),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrapEmpty(
        api.DELETE(
          "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
          {
            params: { path: { ...path, id } },
          }
        )
      ),
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  return (
    <section aria-label="Comments" className="flex flex-col gap-4">
      <Text variant="heading" as="h2">
        Comments
      </Text>
      {comments.isPending ? (
        <LoadingState label="Loading comments" />
      ) : comments.isError ? (
        <ErrorState
          error={comments.error}
          onRetry={() => void comments.refetch()}
        />
      ) : comments.data.length === 0 ? (
        <Text variant="secondary" size="sm">
          No comments yet.
        </Text>
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.data.map((comment) => {
            const mine = !!session && comment.authorId === session.user.id;
            const isEditing = editing?.id === comment.id;
            return (
              <li
                key={comment.id}
                data-testid="comment"
                className="border-kumo-hairline flex flex-col gap-2 rounded-lg border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <Text variant="secondary" size="xs">
                    {mine ? "You" : (comment.externalAuthor ?? "Teammate")} ·{" "}
                    {formatRelative(comment.createdAt)}
                  </Text>
                  {mine && !isEditing ? (
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setEditing({ id: comment.id, body: comment.body })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary-destructive"
                        loading={
                          remove.isPending && remove.variables === comment.id
                        }
                        onClick={() => {
                          if (window.confirm("Delete this comment?"))
                            remove.mutate(comment.id);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  ) : null}
                </div>
                {isEditing ? (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const body = editing.body.trim();
                      if (body && !update.isPending)
                        update.mutate({ id: comment.id, body });
                    }}
                  >
                    <InputArea
                      aria-label="Edit comment"
                      value={editing.body}
                      autoResize
                      minRows={2}
                      onValueChange={(body) =>
                        setEditing({ id: comment.id, body })
                      }
                    />
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        loading={update.isPending}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Text>
                    <Markdown content={comment.body} />
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const body = draft.trim();
          if (body && !add.isPending) add.mutate(body);
        }}
      >
        <InputArea
          aria-label="Add a comment"
          placeholder="Add a comment…"
          value={draft}
          autoResize
          minRows={3}
          onValueChange={setDraft}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={add.isPending}
            disabled={draft.trim().length === 0}
          >
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}

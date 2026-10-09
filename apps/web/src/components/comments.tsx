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

export type IssueHistoryRow = {
  id: string;
  field: string;
  fromValue: string | null;
  toValue: string | null;
  actorId?: string | null;
  createdAt: string;
};

const FIELD_LABELS: Record<string, string> = {
  created: "created the issue",
  status: "changed status",
  priority: "changed priority",
  assignee_id: "assigned to",
  title: "edited the title",
  description: "edited the description",
  team_id: "moved to team",
  project_id: "moved to project",
  cycle_id: "moved to cycle",
  parent_id: "reparented",
  pr_url: "linked pull request",
  pr_state: "pull request",
  pr_check_state: "CI",
};

function humanizeValue(
  field: string,
  value: string | null,
  resolveValue?: (field: string, value: string) => string | undefined
) {
  if (value === null) return "—";
  if (value.startsWith("lane:")) return "an agent lane";
  return resolveValue?.(field, value) ?? value;
}

function historyText(
  row: IssueHistoryRow,
  resolveValue?: (field: string, value: string) => string | undefined
) {
  const v = (value: string | null) =>
    humanizeValue(row.field, value, resolveValue);
  const to = v(row.toValue);
  const from = v(row.fromValue);
  if (from === to && row.field !== "created") return null;
  switch (row.field) {
    case "created":
      return "created the issue";
    case "pr_url":
      return `linked ${to}`;
    case "pr_state":
      return `pull request ${to}`;
    case "pr_check_state":
      return `CI ${to}`;
    default: {
      const label =
        FIELD_LABELS[row.field] ?? `updated ${row.field.replace(/_/g, " ")}`;
      return `${label}: ${from} → ${to}`;
    }
  }
}

export function IssueComments({
  issueId,
  history = [],
  actorName,
  resolveValue,
}: {
  issueId: string;
  history?: IssueHistoryRow[];
  actorName?: (id: string | null | undefined) => string | undefined;
  resolveValue?: (field: string, value: string) => string | undefined;
}) {
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

  const lastCi = history.filter((h) => h.field === "pr_check_state").at(-1);
  const events = history.filter(
    (h) => h.field !== "pr_check_state" || h === lastCi
  );
  const feed = [
    ...(comments.data ?? []).map((c) => ({
      kind: "comment" as const,
      at: c.createdAt,
      c,
    })),
    ...events.map((h) => ({ kind: "event" as const, at: h.createdAt, h })),
  ].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return (
    <section aria-label="Activity" className="flex flex-col gap-4">
      <Text variant="heading" as="h2">
        Activity
      </Text>
      {comments.isPending ? (
        <LoadingState label="Loading activity" />
      ) : comments.isError ? (
        <ErrorState
          error={comments.error}
          onRetry={() => void comments.refetch()}
        />
      ) : feed.length === 0 ? (
        <Text variant="secondary" size="sm">
          No activity yet.
        </Text>
      ) : (
        <ul className="flex flex-col gap-3">
          {feed.map((item) => {
            if (item.kind === "event") {
              const row = item.h;
              const text = historyText(row, resolveValue);
              if (!text) return null;
              return (
                <li
                  key={`h-${row.id}`}
                  className="flex items-baseline gap-2 px-1 text-sm text-kumo-subtle"
                >
                  <span className="min-w-0">
                    {actorName?.(row.actorId) ? (
                      <span className="text-kumo-text font-medium">
                        {actorName(row.actorId)}{" "}
                      </span>
                    ) : null}
                    {text}
                  </span>
                  <span className="shrink-0 text-xs">
                    · {formatRelative(row.createdAt)}
                  </span>
                </li>
              );
            }
            const comment = item.c;
            const mine = !!session && comment.authorId === session.user.id;
            const isEditing = editing?.id === comment.id;
            return (
              <li
                key={`c-${comment.id}`}
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
                    <Markdown
                      workspaceSlug={workspace.slug}
                      content={comment.body}
                    />
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

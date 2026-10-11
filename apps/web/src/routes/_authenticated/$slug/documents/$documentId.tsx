import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { TableOfContents } from "@cloudflare/kumo/components/table-of-contents";
import { Text } from "@cloudflare/kumo/components/text";
import { Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { ShareButton } from "@/components/share-button";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { markdownHeadings } from "@/lib/headings";
import { documentText, formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute(
  "/_authenticated/$slug/documents/$documentId"
)({
  component: DocumentDetail,
});

function DocumentDetail() {
  const { documentId } = Route.useParams();
  const workspace = useWorkspace();
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editingContent, setEditingContent] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const key = wsKey(organizationId, "documents", documentId);
  const path = { organizationId, id: documentId };

  const doc = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
        })
      ),
  });

  const save = useMutation({
    mutationFn: (patch: { title?: string; content?: string }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
          body: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.content !== undefined
              ? { content: patch.content, contentFormat: "markdown" as const }
              : {}),
          },
        })
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "documents"),
      });
      setEditingContent(false);
      toastSuccess("Document saved");
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrapEmpty(
        api.DELETE("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
        })
      ),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "documents"),
      });
      toastSuccess("Document deleted");
      await navigate({
        to: "/$slug/documents",
        params: { slug: workspace.slug },
      });
    },
    onError: (error) => toastError(error),
  });

  const backlinks = useQuery({
    queryKey: wsKey(organizationId, "documents", documentId, "backlinks"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents/{id}/backlinks", {
            params: { path: { organizationId, id: documentId } },
          })
        )
      ).documents,
  });
  const children = useQuery({
    queryKey: wsKey(organizationId, "documents", documentId, "children"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: {
              path: { organizationId },
              query: { parentDocumentId: documentId },
            },
          })
        )
      ).documents,
  });
  const allDocs = useQuery({
    queryKey: wsKey(organizationId, "documents"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: { path: { organizationId } },
          })
        )
      ).documents,
    enabled: (backlinks.data?.length ?? 0) > 0,
  });

  if (doc.isPending) return <LoadingState label="Loading document" />;
  if (doc.isError) {
    return (
      <Page title="Document">
        <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />
      </Page>
    );
  }
  const data = doc.data;
  const text = documentText(data.content);
  const subPages = children.data ?? [];
  const headings = markdownHeadings(text);
  const backlinkRows = (backlinks.data ?? []).map((id) => ({
    id,
    title:
      allDocs.data?.find((d) => d.id === id)?.title ??
      `Document ${id.slice(0, 8)}`,
  }));

  return (
    <Page
      title={data.title}
      description={
        <>
          <Link
            to="/$slug/documents"
            params={{ slug: workspace.slug }}
            className="text-kumo-link"
          >
            Documents
          </Link>{" "}
          · updated {formatRelative(data.updatedAt)}
        </>
      }
      actions={
        <>
          <ShareButton
            organizationId={workspace.id}
            kind="document"
            id={data.id}
          />
          <Button
            variant="secondary-destructive"
            icon={<Trash />}
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm("Move this document to trash?"))
                remove.mutate();
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="flex gap-8">
        <LayerCard className="flex-1 min-w-0">
          <LayerCard.Primary className="p-6">
            <div className="flex items-start gap-3 mb-4">
              {data.icon ? (
                <span className="text-2xl leading-none mt-1">{data.icon}</span>
              ) : null}
              <input
                aria-label="Document title"
                defaultValue={data.title}
                key={`${data.id}-${data.title}`}
                className="w-full bg-transparent text-2xl font-semibold text-kumo-default outline-none placeholder:text-kumo-subtle focus:border-b focus:border-kumo-line"
                placeholder="Untitled"
                onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                  const value = e.target.value.trim();
                  if (value && value !== data.title) {
                    save.mutate({ title: value });
                  } else {
                    e.target.value = data.title;
                  }
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                  if (e.key === "Escape") {
                    e.currentTarget.value = data.title;
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            {subPages.length > 0 ? (
              <div className="flex flex-col gap-1 mb-5">
                {subPages.map((sub) => (
                  <Link
                    key={sub.id}
                    to="/$slug/documents/$documentId"
                    params={{ slug: workspace.slug, documentId: sub.id }}
                    className="text-sm text-kumo-link hover:underline flex items-center gap-2"
                  >
                    <Text as="span" variant="secondary">
                      {sub.icon ?? "📄"}
                    </Text>
                    {sub.title}
                  </Link>
                ))}
              </div>
            ) : null}
            {editingContent ? (
              <div className="flex flex-col gap-2">
                <InputArea
                  ref={contentRef}
                  autoFocus
                  value={draft.content}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, content: e.target.value }))
                  }
                  className="min-h-96 font-mono text-sm w-full"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      save.mutate({ content: draft.content });
                    }
                    if (e.key === "Escape") setEditingContent(false);
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={save.isPending}
                    onClick={() => save.mutate({ content: draft.content })}
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingContent(false)}
                  >
                    Cancel
                  </Button>
                  <span className="text-xs text-kumo-subtle">
                    ⌘↵ to save · Esc to cancel
                  </span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="block w-full cursor-text text-left"
                onClick={() => {
                  setDraft((d) => ({ ...d, content: text }));
                  setEditingContent(true);
                }}
              >
                {text ? (
                  <Markdown workspaceSlug={workspace.slug} content={text} />
                ) : (
                  <Text variant="secondary">Click to start writing…</Text>
                )}
              </button>
            )}
          </LayerCard.Primary>
        </LayerCard>
        {headings.length >= 3 ? (
          <nav className="sticky top-6 hidden w-56 shrink-0 self-start lg:block">
            <TableOfContents>
              <TableOfContents.Title>On this page</TableOfContents.Title>
              <TableOfContents.List>
                {headings.map((h) => (
                  <TableOfContents.Item
                    key={h.slug}
                    href={`#${h.slug}`}
                    className={h.depth > 1 ? "pl-4" : undefined}
                  >
                    {h.text}
                  </TableOfContents.Item>
                ))}
              </TableOfContents.List>
            </TableOfContents>
          </nav>
        ) : null}
      </div>
      {backlinkRows.length > 0 ? (
        <LayerCard>
          <div className="border-b border-kumo-line px-4 py-3">
            <Text variant="secondary">Linked from</Text>
          </div>
          <ul className="px-4 py-3 flex flex-col gap-1.5">
            {backlinkRows.map((b) => (
              <li key={b.id}>
                <Link
                  to="/$slug/documents/$documentId"
                  params={{ slug: workspace.slug, documentId: b.id }}
                  className="text-kumo-link hover:underline"
                >
                  {b.title}
                </Link>
              </li>
            ))}
          </ul>
        </LayerCard>
      ) : null}
    </Page>
  );
}

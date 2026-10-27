import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { TableOfContents } from "@cloudflare/kumo/components/table-of-contents";
import { Text } from "@cloudflare/kumo/components/text";
import { LinkSimple, Plus, Star, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";

import { CanvasEditor } from "@/components/canvas-editor";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityLinksRail } from "@/components/entity-links";
import { EntityPage, RailLink, RailSection } from "@/components/entity-page";
import { IconPicker } from "@/components/icon-picker";
import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { ShareButton } from "@/components/share-button";
import { ErrorState, LoadingState } from "@/components/states";
import { useFavorites } from "@/hooks/use-favorites";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, unwrapEmpty } from "@/lib/api";
import { markdownHeadings } from "@/lib/headings";
import { documentText, formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

import { DOCUMENTS_LIST_QUERY } from "./index";

export const Route = createFileRoute(
  "/_authenticated/$slug/documents/$documentId"
)({
  component: DocumentDetail,
});

/** Cache key for the detail page's title-only document index. Kept under
 * the "documents" subtree (so saves/deletes still invalidate it) but off
 * the bare list key — the index fetches `summary=1` rows while
 * `wsKey(org, "documents")` is the full-shape list, and sharing the key
 * let either payload clobber the other. */
export function documentIndexQueryKey(organizationId: string) {
  return wsKey(organizationId, "documents", "index");
}

/** Walk `parentDocumentId` links root-first for the breadcrumb trail.
 * The hop cap guards against a malformed parent cycle. */
export function documentAncestors<
  T extends { id: string; parentDocumentId: string | null },
>(documents: readonly T[], parentDocumentId: string | null): T[] {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const chain: T[] = [];
  let cursor = parentDocumentId;
  let hops = 0;
  while (cursor && hops < 6) {
    const parent = byId.get(cursor);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent.parentDocumentId;
    hops += 1;
  }
  return chain;
}

function DocumentDetail() {
  const { documentId } = Route.useParams();
  const workspace = useWorkspace();
  const favs = useFavorites(workspace.id);
  const organizationId = workspace.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editingContent, setEditingContent] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const permissions = usePermissions(workspace.id);
  const canDelete = permissions.can("document", "delete");
  const canEdit = permissions.can("document", "edit");
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const canvasSave = useRef<number | null>(null);
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

  const createSubPage = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/documents", {
          params: { path: { organizationId } },
          body: {
            title: "Untitled",
            parentDocumentId: documentId,
          },
        })
      ),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "documents", documentId, "children"),
      });
      void navigate({
        to: "/$slug/documents/$documentId",
        params: { slug: workspace.slug, documentId: created.id },
      });
    },
    onError: (error) => toastError(error),
  });

  const save = useMutation({
    mutationFn: (patch: {
      title?: string;
      content?: string;
      icon?: string | null;
    }) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/documents/{id}", {
          params: { path },
          body: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
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
    queryKey: documentIndexQueryKey(organizationId),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/documents", {
            params: {
              path: { organizationId },
              query: { ...DOCUMENTS_LIST_QUERY },
            },
          })
        )
      ).documents,
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
  const ancestors = documentAncestors(
    allDocs.data ?? [],
    data.parentDocumentId
  );
  const backlinkRows = (backlinks.data ?? []).map((id) => ({
    id,
    title:
      allDocs.data?.find((d) => d.id === id)?.title ??
      `Document ${id.slice(0, 8)}`,
  }));

  return (
    <>
      <EntityPage
        title={data.title}
        description={
          <>
            <Link
              to="/$slug/documents"
              params={{ slug: workspace.slug }}
              className="text-kumo-link"
            >
              Documents
            </Link>
            {ancestors.map((parent) => (
              <Fragment key={parent.id}>
                {" / "}
                <Link
                  to="/$slug/documents/$documentId"
                  params={{ slug: workspace.slug, documentId: parent.id }}
                  className="text-kumo-link"
                >
                  {parent.icon ? `${parent.icon} ` : ""}
                  {parent.title}
                </Link>
              </Fragment>
            ))}
            {" · updated "}
            {formatRelative(data.updatedAt)}
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              loading={createSubPage.isPending}
              onClick={() => createSubPage.mutate()}
            >
              New sub-page
            </Button>
            <ShareButton
              organizationId={workspace.id}
              kind="document"
              id={data.id}
            />
          </>
        }
        menu={
          <>
            <DropdownMenu.Item
              icon={
                <Star
                  weight={
                    favs.isFavorite("document", data.id) ? "fill" : "regular"
                  }
                />
              }
              onClick={() =>
                favs.toggle({
                  type: "document",
                  id: data.id,
                  title: data.title,
                })
              }
            >
              {favs.isFavorite("document", data.id) ? "Unstar" : "Star"}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              icon={<LinkSimple />}
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
                toastSuccess("Link copied");
              }}
            >
              Copy link
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {canDelete ? (
              <DropdownMenu.Item
                variant="danger"
                icon={<Trash />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete document
              </DropdownMenu.Item>
            ) : null}
          </>
        }
        center={
          <>
            <LayerCard className="min-w-0">
              <LayerCard.Primary className="p-6">
                <div className="flex items-start gap-3 mb-4">
                  <IconPicker
                    onSelect={(icon) => save.mutate({ icon })}
                    onRemove={() => save.mutate({ icon: null })}
                  >
                    <button
                      type="button"
                      aria-label="Change icon"
                      className="hover:bg-kumo-tint mt-1 rounded-md p-0.5 text-2xl leading-none"
                    >
                      {data.icon ?? "📄"}
                    </button>
                  </IconPicker>
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
                {(data.contentFormat as string) === "canvas" ? (
                  <CanvasEditor
                    sceneJson={
                      typeof data.content === "string" ? data.content : "{}"
                    }
                    onChange={(json) => {
                      if (canvasSave.current !== null)
                        window.clearTimeout(canvasSave.current);
                      canvasSave.current = window.setTimeout(
                        () => save.mutate({ content: json }),
                        800
                      );
                    }}
                  />
                ) : !isEditable(data.contentFormat) ? (
                  <Text variant="secondary">
                    This document uses rich formatting — edit it from the CLI so
                    its structure is kept.
                  </Text>
                ) : editingContent ? (
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
                      if (!canEdit) return;
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
          </>
        }
        rail={
          <>
            <RailSection title="Relations">
              {data.parentDocumentId && ancestors.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-kumo-subtle">Parent</span>
                  <RailLink
                    to="/$slug/documents/$documentId"
                    params={{
                      slug: workspace.slug,
                      documentId: ancestors[ancestors.length - 1]!.id,
                    }}
                  >
                    {ancestors[ancestors.length - 1]!.icon
                      ? `${ancestors[ancestors.length - 1]!.icon} `
                      : ""}
                    {ancestors[ancestors.length - 1]!.title}
                  </RailLink>
                </div>
              ) : null}
              {data.issueId ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-kumo-subtle">Linked issue</span>
                  <RailLink
                    to="/$slug/issues/$issueId"
                    params={{ slug: workspace.slug, issueId: data.issueId }}
                  >
                    View issue
                  </RailLink>
                </div>
              ) : null}
              <EntityLinksRail entityType="document" entityId={data.id} />
            </RailSection>

            {headings.length >= 3 ? (
              <RailSection title="On this page">
                <TableOfContents>
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
              </RailSection>
            ) : null}
          </>
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Move this document to trash?"
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
      />
    </>
  );
}

// Plain text and markdown round-trip through the inline editor; block
// documents would lose their structure, so they stay read-only here.
function isEditable(format: string): boolean {
  return format === "text" || format === "markdown" || format === "canvas";
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CustomFieldsRail } from "@/components/custom-fields-rail";
import { EntityLinksRail } from "@/components/entity-links";
import { EntityPage, RailLink, RailSection } from "@/components/entity-page";
import { FieldMenu } from "@/components/field-menu";
import { Markdown } from "@/components/markdown";
import { RecordNotes } from "@/components/record-notes";
import { ErrorState, LoadingState } from "@/components/states";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";
import { toastError, toastSuccess } from "@/lib/toast";

export const Route = createFileRoute("/_authenticated/$slug/deals/$dealId")({
  component: DealDetail,
});

const STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currency ?? "USD",
  }).format(cents / 100);
}

function DealDetail() {
  const { dealId } = Route.useParams();
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const permissions = usePermissions(workspace.id);
  const canDelete = permissions.can("deal", "delete");
  const canEdit = permissions.can("deal", "edit");
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState("");
  const key = wsKey(workspace.id, "deals", dealId);

  const deal = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/deals/{dealId}", {
            params: { path: { organizationId: workspace.id, dealId } },
          })
        )
      ).deal,
  });

  const customers = useQuery({
    queryKey: wsKey(workspace.id, "customers"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/customers", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).customers,
  });

  const contacts = useQuery({
    queryKey: wsKey(workspace.id, "contacts"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/support/customers", {
            params: { path: { organizationId: workspace.id }, query: {} },
          })
        )
      ).customers,
  });

  const allIssues = useQuery({
    queryKey: wsKey(workspace.id, "issues"),
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/workspaces/{organizationId}/issues", {
            params: { path: { organizationId: workspace.id } },
          })
        )
      ).issues,
  });

  const linkedIssues = useQuery({
    queryKey: wsKey(workspace.id, "deals", dealId, "issues"),
    queryFn: async () => {
      const { issueIds } = await unwrap(
        api.GET("/workspaces/{organizationId}/deals/{dealId}/issues", {
          params: { path: { organizationId: workspace.id, dealId } },
        })
      );
      const issues = await Promise.all(
        issueIds.map(async (id) => {
          try {
            const res = await unwrap(
              api.GET("/workspaces/{organizationId}/issues/{id}", {
                params: { path: { organizationId: workspace.id, id } },
              })
            );
            return res;
          } catch {
            return null;
          }
        })
      );
      return issues.filter((i): i is NonNullable<typeof i> => i !== null);
    },
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      unwrap(
        api.PATCH("/workspaces/{organizationId}/deals/{dealId}", {
          params: { path: { organizationId: workspace.id, dealId } },
          body: body as never,
        })
      ),
    onError: (error) => toastError(error),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals"),
      }),
  });

  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/workspaces/{organizationId}/deals/{dealId}", {
          params: { path: { organizationId: workspace.id, dealId } },
        })
      ),
    onSuccess: () => {
      toastSuccess("Deal deleted");
      void navigate({
        to: "/$slug/tickets",
        params: { slug: workspace.slug },
      });
    },
    onError: (error) => toastError(error),
  });

  const linkIssue = useMutation({
    mutationFn: (issueId: string) =>
      unwrap(
        api.PUT("/workspaces/{organizationId}/deals/{dealId}/issues", {
          params: { path: { organizationId: workspace.id, dealId } },
          body: { issueId },
        })
      ),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals", dealId, "issues"),
      }),
  });

  const unlinkIssue = useMutation({
    mutationFn: (issueId: string) =>
      unwrap(
        api.DELETE(
          "/workspaces/{organizationId}/deals/{dealId}/issues/{issueId}",
          {
            params: {
              path: {
                organizationId: workspace.id,
                dealId,
                issueId,
              },
            },
          }
        )
      ),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "deals", dealId, "issues"),
      }),
  });

  if (deal.isPending) return <LoadingState label="Loading deal" />;
  if (deal.isError || !deal.data) {
    return (
      <ErrorState
        error={deal.error ?? new Error("Deal not found")}
        onRetry={() => void deal.refetch()}
      />
    );
  }
  const data = deal.data;
  const customer = customers.data?.find((c) => c.id === data.customerId);

  return (
    <>
      <EntityPage
        title={data.name}
        description={
          <>
            <Link
              to="/$slug/sales"
              params={{ slug: workspace.slug }}
              search={{ tab: "deals" }}
              className="text-kumo-link"
            >
              Sales / Deals
            </Link>
            {" · updated "}
            {formatRelative(data.updatedAt)}
          </>
        }
        actions={
          <FieldMenu
            title="Stage"
            options={[...STAGES]}
            labels={STAGE_LABELS}
            onSelect={(v) => patch.mutate({ stage: v })}
          >
            <button type="button" className="cursor-pointer">
              <Badge
                variant={
                  data.stage === "won"
                    ? "green"
                    : data.stage === "lost"
                      ? "neutral"
                      : "blue"
                }
              >
                {STAGE_LABELS[data.stage]}
              </Badge>
            </button>
          </FieldMenu>
        }
        menu={
          <>
            {canDelete ? (
              <DropdownMenu.Item
                variant="danger"
                icon={<Trash />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete deal
              </DropdownMenu.Item>
            ) : null}
          </>
        }
        center={
          <>
            {editingDesc ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate({ description: desc });
                  setEditingDesc(false);
                }}
              >
                <InputArea
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Deal context — what's the ask, who's involved, what's the path to close."
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" size="sm">
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingDesc(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="w-full text-left"
                onClick={() => {
                  if (!canEdit) return;
                  setDesc(data.description ?? "");
                  setEditingDesc(true);
                }}
              >
                {data.description ? (
                  <Markdown
                    workspaceSlug={workspace.slug}
                    content={data.description}
                  />
                ) : (
                  <span className="text-sm text-kumo-subtle">
                    Add deal context…
                  </span>
                )}
              </button>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-kumo-subtle">
                Linked issues
              </h3>
              <LinkIssues
                issues={allIssues.data ?? []}
                linked={new Set((linkedIssues.data ?? []).map((i) => i.id))}
                onLink={(id) => linkIssue.mutate(id)}
                pending={linkIssue.isPending}
              />
              {(linkedIssues.data ?? []).map((issue) => (
                <div key={issue.id}>
                  <Link
                    to="/$slug/issues/$issueId"
                    params={{ slug: workspace.slug, issueId: issue.id }}
                    className="text-kumo-link hover:underline"
                  >
                    {issue.identifier ? `${issue.identifier} · ` : ""}
                    {issue.title}
                  </Link>
                  <button
                    type="button"
                    aria-label="Unlink issue"
                    onClick={() => unlinkIssue.mutate(issue.id)}
                    className="text-kumo-subtle hover:text-kumo-default"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <RecordNotes entityType="deal" entityId={data.id} />
          </>
        }
        rail={
          <>
            <RailSection title="Properties">
              <Select
                aria-label="Company"
                value={data.customerId}
                onValueChange={(v) => v && patch.mutate({ customerId: v })}
              >
                {(customers.data ?? []).map((c) => (
                  <Select.Option key={c.id} value={c.id}>
                    {c.name}
                  </Select.Option>
                ))}
              </Select>
              <div className="flex flex-col gap-2 text-sm text-kumo-subtle">
                <div className="flex items-center justify-between">
                  <span>Amount</span>
                  <span className="text-kumo-default">
                    {money(data.amountCents, data.currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Expected close</span>
                  <span className="text-kumo-default">
                    {data.expectedCloseAt?.slice(0, 10) ?? "—"}
                  </span>
                </div>
                {data.closedAt ? (
                  <div className="flex items-center justify-between">
                    <span>Closed</span>
                    <span className="text-kumo-default">
                      {data.closedAt.slice(0, 10)}
                    </span>
                  </div>
                ) : null}
              </div>
              <CustomFieldsRail entityType="deal" entityId={data.id} />
            </RailSection>

            <RailSection title="Relations">
              <RailLink
                to="/$slug/customers/$customerId"
                params={{
                  slug: workspace.slug,
                  customerId: data.customerId,
                }}
              >
                {customer?.name ?? data.customerId.slice(0, 8)}
              </RailLink>
              {data.contactIds.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {data.contactIds.map((id) => {
                    const contact = contacts.data?.find((c) => c.id === id);
                    return (
                      <div key={id} className="flex items-center gap-2">
                        <RailLink
                          to="/$slug/contacts/$contactId"
                          params={{ slug: workspace.slug, contactId: id }}
                        >
                          {contact?.fullName ?? contact?.email ?? id.slice(0, 8)}
                        </RailLink>
                        <button
                          type="button"
                          aria-label="Remove contact"
                          onClick={() =>
                            patch.mutate({
                              contactIds: data.contactIds.filter((c) => c !== id),
                            })
                          }
                          className="text-kumo-subtle hover:text-kumo-default"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <AddDealContact
                contacts={(contacts.data ?? []).filter(
                  (c) => !data.contactIds.includes(c.id)
                )}
                onAdd={(id) =>
                  patch.mutate({
                    contactIds: [...data.contactIds, id],
                  })
                }
              />
              <EntityLinksRail entityType="deal" entityId={data.id} />
            </RailSection>
          </>
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this deal?"
        description="This can't be undone."
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
      />
    </>
  );
}

function LinkIssues({
  issues,
  linked,
  onLink,
  pending,
}: {
  issues: { id: string; identifier: string | null; title: string }[];
  linked: Set<string>;
  onLink: (issueId: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Link an issue…
      </Button>
    );
  }
  const candidates = issues.filter((i) => !linked.has(i.id));
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label="Link issue"
        value=""
        onValueChange={(v) => {
          if (v) {
            onLink(v);
            setOpen(false);
          }
        }}
      >
        {candidates.map((i) => (
          <Select.Option key={i.id} value={i.id}>
            {i.identifier ? `${i.identifier} ` : ""}
            {i.title}
          </Select.Option>
        ))}
      </Select>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
        loading={pending}
      >
        Cancel
      </Button>
    </div>
  );
}

function AddDealContact({
  contacts,
  onAdd,
}: {
  contacts: { id: string; fullName: string | null; email: string }[];
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (contacts.length === 0) return null;
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Add contact…
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label="Add contact"
        value=""
        onValueChange={(v) => {
          if (v) {
            onAdd(v);
            setOpen(false);
          }
        }}
      >
        {contacts.map((c) => (
          <Select.Option key={c.id} value={c.id}>
            {c.fullName ?? c.email}
          </Select.Option>
        ))}
      </Select>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

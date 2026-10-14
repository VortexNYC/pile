import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { User } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityHover } from "@/components/entity-hover";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/labels";

/** The people — support customers as first-class contacts. */
export function ContactsList() {
  const workspace = useWorkspace();
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

  if (contacts.isPending) return <LoadingState label="Loading contacts" />;
  if (contacts.isError) {
    return (
      <ErrorState
        error={contacts.error}
        onRetry={() => void contacts.refetch()}
      />
    );
  }
  if (contacts.data.length === 0) {
    return (
      <EmptyState
        icon={<User size={40} />}
        title="No contacts"
        description="People appear here as tickets, captures, and lead intake create them."
      />
    );
  }

  return (
    <>
      <LayerCard className="p-0">
        <Table aria-label="Contacts">
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head>Email</Table.Head>
              <Table.Head>Added</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {contacts.data.map((contact) => (
              <Table.Row key={contact.id}>
                <Table.Cell>
                  <EntityHover
                    title={contact.fullName ?? contact.email}
                    description={contact.fullName ? contact.email : null}
                  >
                    <Link
                      to="/$slug/contacts/$contactId"
                      params={{
                        slug: workspace.slug,
                        contactId: contact.id,
                      }}

                      className="text-kumo-link hover:underline"
                    >
                      {contact.fullName ?? contact.email}
                    </Link>
                  </EntityHover>
                </Table.Cell>
                <Table.Cell className="text-sm text-kumo-subtle">
                  {contact.email}
                </Table.Cell>
                <Table.Cell>{formatRelative(contact.createdAt)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
    </>
  );
}

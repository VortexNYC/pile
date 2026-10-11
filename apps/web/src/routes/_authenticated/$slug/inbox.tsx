import { createFileRoute } from "@tanstack/react-router";

import { InboxList } from "@/components/inbox-list";
import { Page } from "@/components/page";
import { useWorkspace } from "@/hooks/use-workspace";

export const Route = createFileRoute("/_authenticated/$slug/inbox")({
  component: Inbox,
});

function Inbox() {
  const workspace = useWorkspace();
  return (
    <Page title="Inbox" description="What needs your attention.">
      <InboxList organizationId={workspace.id} slug={workspace.slug} />
    </Page>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Page } from "@/components/page";
import { SessionsList } from "@/components/sessions-list";

export const Route = createFileRoute("/_authenticated/$slug/sessions/")({
  component: Sessions,
});

function Sessions() {
  const [agentSlug, setAgentSlug] = useState("");
  return (
    <Page title="Sessions" description="Agent sessions across the workspace.">
      <input
        value={agentSlug}
        onChange={(e) => setAgentSlug(e.target.value)}
        placeholder="Filter by agent (e.g. scout)"
        className="mb-3 w-56 rounded border px-2 py-1 text-sm"
      />
      <SessionsList agentSlug={agentSlug || undefined} />
    </Page>
  );
}

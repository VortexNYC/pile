import { Input } from "@cloudflare/kumo/components/input";
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
      <div className="mb-3 w-56">
        <Input
          value={agentSlug}
          onChange={(e) => setAgentSlug(e.target.value)}
          placeholder="Filter by agent (e.g. scout)"
          aria-label="Filter sessions by agent"
        />
      </div>
      <SessionsList agentSlug={agentSlug || undefined} />
    </Page>
  );
}

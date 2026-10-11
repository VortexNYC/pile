import { createFileRoute } from "@tanstack/react-router";

import { CapturesGrid } from "@/components/captures-grid";
import { Page } from "@/components/page";

export const Route = createFileRoute("/_authenticated/$slug/captures/")({
  component: Captures,
});

function Captures() {
  return (
    <Page
      title="Captures"
      description="Every screenshot, video, and log across support tickets."
    >
      <CapturesGrid />
    </Page>
  );
}

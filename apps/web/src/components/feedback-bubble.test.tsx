import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceContext, wsKey, type Workspace } from "@/hooks/use-workspace";

import { FEEDBACK_KINDS, FeedbackBubble } from "./feedback-bubble";

const workspace: Workspace = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  key: "acm",
  ownerId: "user-1",
  defaultTeamId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderBubble(permissions: {
  role: string | null;
  permissions: string[];
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(wsKey(workspace.id, "my-permissions"), permissions);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WorkspaceContext.Provider value={workspace}>
        <FeedbackBubble />
      </WorkspaceContext.Provider>
    </QueryClientProvider>
  );
}

describe("FeedbackBubble", () => {
  it("is a mountable component", () => {
    expect(typeof FeedbackBubble).toBe("function");
  });

  it("mounts the floating launcher for an owner", () => {
    const html = renderBubble({ role: "owner", permissions: [] });
    expect(html).toContain('aria-label="Send feedback"');
  });

  it("mounts the floating launcher for a member with ticket:create", () => {
    const html = renderBubble({
      role: "member",
      permissions: ["ticket:view", "ticket:create"],
    });
    expect(html).toContain('aria-label="Send feedback"');
  });

  it("stays mounted while permissions are still loading", () => {
    // No seeded query data — the permissions query is pending, which
    // must not hide the launcher (the report UI being invisible was the
    // user-visible regression this guards).
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceContext.Provider value={workspace}>
          <FeedbackBubble />
        </WorkspaceContext.Provider>
      </QueryClientProvider>
    );
    expect(html).toContain('aria-label="Send feedback"');
  });

  it("hides only for a confirmed denial — a member without ticket:create", () => {
    const html = renderBubble({ role: "member", permissions: ["issue:view"] });
    expect(html).not.toContain('aria-label="Send feedback"');
  });
});

describe("FEEDBACK_KINDS", () => {
  it("covers exactly the kinds the API accepts", () => {
    // Mirrors memberFeedbackBodySchema.kind in src/api/support-capture.ts.
    expect(FEEDBACK_KINDS.map((k) => k.value)).toEqual([
      "bug",
      "feature",
      "other",
    ]);
  });

  it("gives every kind a human label", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(kind.label.length).toBeGreaterThan(0);
    }
  });
});

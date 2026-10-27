import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { api, unwrap } from "@/lib/api";
import { slugify } from "@/lib/labels";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: Onboarding,
});

/** Ready-to-paste connect snippets for the post-signup checklist. */
export function buildOnboardingSnippets(
  origin: string,
  token: string
): { cliCommand: string; mcpUrl: string; mcpConfigJson: string } {
  return {
    cliCommand: `pile config set --base-url ${origin} --api-key ${token}`,
    mcpUrl: `${origin}/mcp`,
    mcpConfigJson: JSON.stringify(
      { mcpServers: { pile: { url: `${origin}/mcp` } } },
      null,
      2
    ),
  };
}

interface OnboardedState {
  slug: string;
  token: string;
  mcpUrl: string;
  cliSetupCommand: string;
  seededIssueIds: string[];
}

function Onboarding() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [onboarded, setOnboarded] = useState<OnboardedState | null>(null);
  const [copied, setCopied] = useState<"key" | "cli" | "mcp" | null>(null);
  const effectiveSlug = slugTouched ? slug : slugify(name);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces/onboard", {
          body: {
            name: name.trim(),
            slug: effectiveSlug,
            seedStarterIssues: true,
          },
        })
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      const snippets = buildOnboardingSnippets(
        window.location.origin,
        result.token
      );
      setOnboarded({
        slug: result.workspace.slug,
        token: result.token,
        mcpUrl: result.quickstart?.mcpUrl ?? snippets.mcpUrl,
        cliSetupCommand:
          result.quickstart?.cliSetupCommand ?? snippets.cliCommand,
        seededIssueIds: result.quickstart?.seededIssueIds ?? [],
      });
    },
  });

  const copy = async (which: "key" | "cli" | "mcp", text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="bg-kumo-canvas flex min-h-dvh items-center justify-center px-4">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Primary className="flex flex-col gap-4 p-6">
          {onboarded ? (
            <>
              <div className="flex flex-col gap-1">
                <Text variant="heading" as="h1" size="lg">
                  Workspace ready — connect your agents
                </Text>
                <Text variant="secondary" size="sm">
                  Save your admin API key now — it is only shown once.
                </Text>
              </div>
              <Input
                label="Admin API key"
                value={onboarded.token}
                readOnly
                description="Used by the CLI, SDK, and MCP as a Bearer token."
              />
              <Button
                variant="secondary"
                onClick={() => void copy("key", onboarded.token)}
              >
                {copied === "key" ? "Copied" : "Copy API key"}
              </Button>
              <Input
                label="CLI setup"
                value={onboarded.cliSetupCommand}
                readOnly
                description="Run once to configure the pile CLI."
              />
              <Button
                variant="secondary"
                onClick={() => void copy("cli", onboarded.cliSetupCommand)}
              >
                {copied === "cli" ? "Copied" : "Copy CLI command"}
              </Button>
              <Input
                label="MCP endpoint"
                value={onboarded.mcpUrl}
                readOnly
                description="Point any MCP connector here with your API key."
              />
              <Button
                variant="secondary"
                onClick={() => void copy("mcp", onboarded.mcpUrl)}
              >
                {copied === "mcp" ? "Copied" : "Copy MCP URL"}
              </Button>
              <div className="flex flex-col gap-1">
                <Text size="sm">✓ Workspace & default team created</Text>
                <Text size="sm">✓ Admin API key minted</Text>
                <Text size="sm">
                  ✓ Starter issues seeded
                  {onboarded.seededIssueIds.length > 0
                    ? ` (${onboarded.seededIssueIds.length})`
                    : ""}
                </Text>
              </div>
              <Button
                variant="primary"
                onClick={() =>
                  void navigate({
                    to: "/$slug/issues",
                    params: { slug: onboarded.slug },
                  })
                }
              >
                Continue to workspace
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Text variant="heading" as="h1" size="lg">
                  Create your workspace
                </Text>
                <Text variant="secondary" size="sm">
                  A workspace holds your team's issues, documents, and support
                  tickets. Ask a teammate for an invite to join an existing one.
                </Text>
              </div>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!create.isPending) create.mutate();
                }}
              >
                <Input
                  label="Workspace name"
                  value={name}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
                <Input
                  label="URL name"
                  description={`pile.nyc/app/${effectiveSlug || "your-team"}`}
                  value={effectiveSlug}
                  required
                  pattern="[a-z0-9-]+"
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(slugify(event.target.value));
                  }}
                />
                {create.isError ? (
                  <Text variant="error" size="sm">
                    {create.error.message}
                  </Text>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  loading={create.isPending}
                  disabled={
                    name.trim().length === 0 || effectiveSlug.length === 0
                  }
                >
                  Create workspace
                </Button>
              </form>
            </>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}

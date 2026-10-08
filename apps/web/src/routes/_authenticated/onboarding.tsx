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

function Onboarding() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const effectiveSlug = slugTouched ? slug : slugify(name);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/workspaces", {
          body: { name: name.trim(), slug: effectiveSlug },
        })
      ),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await navigate({
        to: "/$slug/issues",
        params: { slug: workspace.slug },
      });
    },
  });

  return (
    <div className="bg-kumo-canvas flex min-h-dvh items-center justify-center px-4">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Primary className="flex flex-col gap-4 p-6">
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
              disabled={name.trim().length === 0 || effectiveSlug.length === 0}
            >
              Create workspace
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}

import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";
import { openapi } from "blume/reference";

export default defineConfig({
  title: "Pile",
  description:
    "Pile issue tracker — open-source, agent-native, Linear alternative.",
  reference: [
    openapi({
      route: "/api",
      sources: [{ label: "HTTP API", spec: "../../src/mcp/openapi.json" }],
    }),
  ],
  agents: {
    llmsTxt: true,
    mcp: {
      enabled: true,
    },
  },
  deployment: cloudflare({ site: "https://docs.pile.nyc" }),
});

import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";
import { openapi } from "blume/reference";
import { filesystem, githubReleases } from "blume/sources";

export default defineConfig({
  title: "Pile",
  description:
    "Pile issue tracker — open-source, agent-native, Linear alternative.",
  github: {
    owner: "VortexNYC",
    repo: "pile",
    dir: "packages/docs/docs",
  },
  content: {
    sources: [
      filesystem({ root: "docs" }),
      githubReleases({
        prefix: "changelog",
        owner: "VortexNYC",
        repo: "pile",
      }),
    ],
  },
  reference: [
    openapi({
      route: "/api",
      sources: [{ label: "HTTP API", spec: "../../src/mcp/openapi.json" }],
    }),
  ],
  navigation: {
    tabs: [
      { label: "API Reference", path: "/api" },
      { label: "Changelog", path: "/changelog" },
    ],
    actions: [
      {
        label: "GitHub",
        href: "https://github.com/VortexNYC/pile",
      },
      {
        label: "npm",
        href: "https://www.npmjs.com/package/@vortex-api/pile",
      },
    ],
  },
  redirects: [
    { from: "/agents", to: "/agent-setup" },
    { from: "/concepts", to: "/data-model" },
  ],
  seo: {
    organization: {
      name: "Vortex",
      sameAs: [
        "https://github.com/VortexNYC",
        "https://www.npmjs.com/package/@vortex-api/pile",
      ],
    },
    software: {
      license: "Apache-2.0",
      price: 0,
      operatingSystem: "Cloudflare Workers",
    },
  },
  theme: {
    fonts: {
      body: "inter",
      display: "inter-tight",
      mono: "geist-mono",
    },
  },
  agents: {
    llmsTxt: {
      details:
        "Pile is an open-source, agent-native issue tracker and workspace on Cloudflare Workers (Durable Objects + D1): issues, documents, projects, support tickets, CRM, and agent sessions share one entity graph. Humans and agents use the same API — every OpenAPI operation is also an MCP tool at <worker>/mcp and a CLI command in @vortex-api/pile. Use these docs when connecting an agent or self-hosting.",
    },
    mcp: {
      enabled: true,
    },
  },
  deployment: cloudflare({ site: "https://docs.pile.nyc" }),
});

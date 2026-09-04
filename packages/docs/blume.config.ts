import { defineConfig } from "blume";

export default defineConfig({
  title: "Vortex",
  description:
    "Vortex issue tracker — open-source, agent-native, Linear alternative.",
  openapi: {
    enabled: true,
    route: "/api",
    sources: [{ label: "HTTP API", spec: "../../src/mcp/openapi.json" }],
  },
  ai: {
    llmsTxt: true,
  },
});

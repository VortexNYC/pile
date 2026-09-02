import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import app from "../src/api/index.js";

const repoRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(repoRoot, "src/mcp/openapi.json");

const doc = app.getOpenAPIDocument({
  openapi: "3.0.0",
  info: {
    title: "Vortex Issue Tracker",
    version: "0.1.0",
    description: "OpenAPI source of truth for REST, CLI, and MCP surfaces.",
  },
});

writeFileSync(outputPath, `${JSON.stringify(doc, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, proof: "openapi", path: outputPath }));

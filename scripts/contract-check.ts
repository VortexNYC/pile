#!/usr/bin/env -S tsx
import { execSync } from "node:child_process";

const generated = [
  "src/mcp/openapi.json",
  "src/mcp/mcp-tools.ts",
  "src/client/types.ts",
];

function run(label: string, command: string): void {
  console.log(`[contract-check] ${label}`);
  execSync(command, { stdio: "inherit" });
}

try {
  run("regenerating MCP artifacts", "pnpm run mcp:generate");
  run("regenerating client types", "pnpm run client:generate");

  console.log("[contract-check] verifying generated artifacts are committed");
  const diff = execSync(`git diff -- ${generated.join(" ")}`, {
    encoding: "utf8",
  });
  if (diff.length > 0) {
    console.error(
      "[contract-check] generated artifacts are out of sync. Run pnpm run mcp:generate and pnpm run client:generate, then commit the changes."
    );
    console.error(diff);
    process.exit(1);
  }

  console.log(
    JSON.stringify({ ok: true, proof: "contract-check", files: generated })
  );
} catch (error) {
  console.error(error);
  process.exit(1);
}

import { describe, expect, it } from "vitest";

import { buildOnboardingSnippets } from "./onboarding.js";

describe("buildOnboardingSnippets (PILE-639)", () => {
  it("builds the CLI command, MCP URL, and JSON config from origin+token", () => {
    const snippets = buildOnboardingSnippets("https://pile.nyc", "key-123");
    expect(snippets.cliCommand).toBe(
      "pile config set --base-url https://pile.nyc --api-key key-123"
    );
    expect(snippets.mcpUrl).toBe("https://pile.nyc/mcp");
    const parsed = JSON.parse(snippets.mcpConfigJson) as {
      mcpServers: { pile: { url: string } };
    };
    expect(parsed.mcpServers.pile.url).toBe("https://pile.nyc/mcp");
  });
});

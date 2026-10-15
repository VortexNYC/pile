import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { workspaceSchema } from "./schema-map.js";
import {
  workspaceAgentHandoffs,
  workspaceEntityAttachments,
  workspaceGuidancePacks,
  workspaceGuidancePackVersions,
} from "./schema.js";

describe("workspaceSchema map", () => {
  it("registers entity_attachments so DO drizzle queries can reach it", () => {
    expect(workspaceSchema.workspaceEntityAttachments).toBe(
      workspaceEntityAttachments
    );
    expect(getTableName(workspaceSchema.workspaceEntityAttachments)).toBe(
      "entity_attachments"
    );
  });

  it("registers the guidance pack tables (PILE-423)", () => {
    expect(workspaceSchema.workspaceGuidancePacks).toBe(workspaceGuidancePacks);
    expect(workspaceSchema.workspaceGuidancePackVersions).toBe(
      workspaceGuidancePackVersions
    );
    expect(getTableName(workspaceGuidancePacks)).toBe("guidance_packs");
    expect(getTableName(workspaceGuidancePackVersions)).toBe(
      "guidance_pack_versions"
    );
  });

  it("registers agent_handoffs (PILE-421)", () => {
    expect(workspaceSchema.workspaceAgentHandoffs).toBe(workspaceAgentHandoffs);
    expect(getTableName(workspaceAgentHandoffs)).toBe("agent_handoffs");
  });
});

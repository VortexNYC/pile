import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { workspaceSchema } from "./schema-map.js";
import {
  workspaceEntityAttachments,
  workspaceExternalEventDeliveries,
  workspaceExternalEventMappings,
  workspaceGuidancePacks,
  workspaceGuidancePackVersions,
  workspaceTriageRuleEvaluations,
  workspaceTriageRules,
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
});

describe("external event tables (PILE-422)", () => {
  it("registers external_event_mappings and external_event_deliveries", () => {
    expect(workspaceSchema.workspaceExternalEventMappings).toBe(
      workspaceExternalEventMappings
    );
    expect(workspaceSchema.workspaceExternalEventDeliveries).toBe(
      workspaceExternalEventDeliveries
    );
    expect(getTableName(workspaceExternalEventMappings)).toBe(
      "external_event_mappings"
    );
    expect(getTableName(workspaceExternalEventDeliveries)).toBe(
      "external_event_deliveries"
    );
  });
});

describe("triage tables (PILE-427)", () => {
  it("maps the triage rule + evaluation tables", () => {
    expect(workspaceSchema.workspaceTriageRules).toBe(workspaceTriageRules);
    expect(workspaceSchema.workspaceTriageRuleEvaluations).toBe(
      workspaceTriageRuleEvaluations
    );
    expect(getTableName(workspaceTriageRules)).toBe("triage_rules");
    expect(getTableName(workspaceTriageRuleEvaluations)).toBe(
      "triage_rule_evaluations"
    );
  });
});

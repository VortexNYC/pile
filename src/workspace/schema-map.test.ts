import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { workspaceSchema } from "./schema-map.js";
import { workspaceEntityAttachments } from "./schema.js";

describe("workspaceSchema map", () => {
  it("registers entity_attachments so DO drizzle queries can reach it", () => {
    expect(workspaceSchema.workspaceEntityAttachments).toBe(
      workspaceEntityAttachments
    );
    expect(getTableName(workspaceSchema.workspaceEntityAttachments)).toBe(
      "entity_attachments"
    );
  });
});

import { describe, expect, it } from "vitest";

import { aliasesFor, MCP_TOOL_ALIASES } from "./mcp-aliases.js";

describe("MCP tool aliases", () => {
  it("maps memory_recall and memory_remember to workspace memory operations (VTX-645)", () => {
    expect(MCP_TOOL_ALIASES.memory_recall).toBe(
      "getWorkspacesOrganizationIdMemory"
    );
    expect(MCP_TOOL_ALIASES.memory_remember).toBe(
      "postWorkspacesOrganizationIdMemory"
    );
    expect(aliasesFor("getWorkspacesOrganizationIdMemory")).toContain(
      "memory_recall"
    );
    expect(aliasesFor("postWorkspacesOrganizationIdMemory")).toContain(
      "memory_remember"
    );
  });

  it("maps the PILE-616/617/627/628 memory parity operations", () => {
    expect(MCP_TOOL_ALIASES.memory_update).toBe(
      "patchWorkspacesOrganizationIdMemoryId"
    );
    expect(MCP_TOOL_ALIASES.memory_delete).toBe(
      "deleteWorkspacesOrganizationIdMemoryId"
    );
    expect(MCP_TOOL_ALIASES.memory_forget).toBe(
      "deleteWorkspacesOrganizationIdMemoryId"
    );
    expect(MCP_TOOL_ALIASES.memory_profile).toBe(
      "getWorkspacesOrganizationIdMemoryProfile"
    );
    expect(MCP_TOOL_ALIASES.memory_remember_batch).toBe(
      "postWorkspacesOrganizationIdMemoryBatch"
    );
    expect(MCP_TOOL_ALIASES.memory_extract).toBe(
      "postWorkspacesOrganizationIdMemoryExtract"
    );
    // Both delete aliases resolve to the same underlying tool.
    const delAliases = aliasesFor("deleteWorkspacesOrganizationIdMemoryId");
    expect(delAliases).toContain("memory_delete");
    expect(delAliases).toContain("memory_forget");
    expect(aliasesFor("getWorkspacesOrganizationIdMemoryProfile")).toContain(
      "memory_profile"
    );
    expect(MCP_TOOL_ALIASES.customer_signal_record).toBe(
      "postWorkspacesOrganizationIdCustomersIdSignals"
    );
    expect(MCP_TOOL_ALIASES.customer_send_gate).toBe(
      "postWorkspacesOrganizationIdCustomersIdSendgate"
    );
    expect(MCP_TOOL_ALIASES.customer_reply_ingest).toBe(
      "postWorkspacesOrganizationIdCustomersIdReplyingest"
    );
    expect(MCP_TOOL_ALIASES.customer_audience_query).toBe(
      "postWorkspacesOrganizationIdCustomersAudiencequery"
    );
    expect(MCP_TOOL_ALIASES.customer_run_play).toBe(
      "postWorkspacesOrganizationIdCustomersIdRunplay"
    );
    expect(MCP_TOOL_ALIASES.customer_morning_brief).toBe(
      "postWorkspacesOrganizationIdCustomersMorningbrief"
    );
    expect(MCP_TOOL_ALIASES.customer_pull_leads).toBe(
      "postWorkspacesOrganizationIdCustomersPullleads"
    );
    expect(MCP_TOOL_ALIASES.customer_approve_batch).toBe(
      "postWorkspacesOrganizationIdCustomersApprovebatch"
    );
  });
});

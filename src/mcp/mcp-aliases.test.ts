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

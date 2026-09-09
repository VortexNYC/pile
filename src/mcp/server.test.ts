import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../index.js";

function mcpRequest(body: unknown) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("MCP integration", () => {
  it("initializes and lists tools", async () => {
    const initRes = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
      env
    );

    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as {
      result?: { protocolVersion?: string };
    };
    expect(initBody.result?.protocolVersion).toBe("2024-11-05");

    const listRes = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      env
    );

    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      result?: { tools?: unknown[] };
    };
    expect(listBody.result?.tools?.length).toBe(284);

    const callRes = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "getWorkspaces",
          arguments: {},
        },
      }),
      env
    );

    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as {
      result?: { content?: { text?: string }[] };
    };
    const parsed = JSON.parse(callBody.result?.content?.[0]?.text ?? "null");
    expect(Array.isArray(parsed.workspaces)).toBe(true);
  });
});

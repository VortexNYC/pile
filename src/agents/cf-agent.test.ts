import { describe, expect, it, vi } from "vitest";

import type { Issue } from "../types/workspace.js";
import { CfAgentProvider } from "./cf-agent.js";

const issue = {
  id: "issue-1",
  identifier: "ISS-1",
  title: "Deal step",
  description: null,
  repo: null,
  branch: null,
  status: "todo",
  priority: 0,
  labelIds: [],
} as unknown as Issue;

describe("CfAgentProvider dispatch payload (Flue profiles)", () => {
  it("sends the registry profile and conversation key in the body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, conversationId: "conv-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const provider = new CfAgentProvider(
      {
        AGENT_PROVIDER_CONFIG: JSON.stringify({
          endpoint: "https://flue.example.com",
        }),
        AGENT_PROVIDER_TOKEN: "tok",
      } as never,
      "flue"
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await provider.dispatch("org-1", issue, undefined, {
        sessionId: "sess-1",
        agentProfile: {
          slug: "sales-scout",
          name: "Sales Scout",
          jobSpec: "Find merchants",
          toolScope: "web",
        },
        conversationKey: "merchant-42-sales-scout",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [req] = fetchSpy.mock.calls[0] as [Request];
    const body = (await req.json()) as {
      agent: string;
      profile: { slug: string; jobSpec: string | null };
      conversationKey: string;
    };
    expect(req.url).toBe("https://flue.example.com/dispatch/pile");
    expect(body.agent).toBe("sales-scout");
    expect(body.profile.slug).toBe("sales-scout");
    expect(body.profile.jobSpec).toBe("Find merchants");
    expect(body.conversationKey).toBe("merchant-42-sales-scout");
  });
});

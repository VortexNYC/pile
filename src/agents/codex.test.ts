import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import { CodexAgentProvider } from "./codex.js";

function codexEnv(overrides?: { config?: string }): {
  OPENAI_API_KEY: string;
  AGENT_PROVIDER_CONFIG?: string;
} {
  return {
    OPENAI_API_KEY: "sk-test",
    ...overrides,
  };
}

function mockFetch(
  responses: {
    url: string | RegExp;
    method?: string;
    response: () => unknown;
  }[]
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const match = responses.find(
      (r) =>
        (typeof r.url === "string" ? url === r.url : r.url.test(url)) &&
        (r.method === undefined || r.method === method)
    );
    if (match) {
      const body = match.response();
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

describe("CodexAgentProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a session with the issue prompt", async () => {
    const fetchSpy = mockFetch([
      {
        url: "https://api.openai.com/v1/agents/sessions",
        method: "POST",
        response: () => ({ id: "sess_123" }),
      },
    ]);

    const provider = new CodexAgentProvider(codexEnv() as unknown as AppEnv);
    const result = await provider.dispatch("org-1", {
      id: "issue-1",
      title: "Add a thing",
      description: "do it",
      repo: "VortexNYC/pile",
    } as unknown as import("../types/workspace.js").Issue);

    expect(result.id).toBe("sess_123");
    expect(result.status).toBe("created");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("polls a completed session and extracts a PR URL from assistant text", async () => {
    const fetchSpy = mockFetch([
      {
        url: "https://api.openai.com/v1/agents/sessions/sess_123",
        response: () => ({ id: "sess_123", status: "idle" }),
      },
      {
        url: /\/agents\/sessions\/sess_123\/items/,
        response: () => ({
          data: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
            {
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Done. Opened https://github.com/VortexNYC/pile/pull/42",
                },
              ],
            },
          ],
        }),
      },
    ]);

    const provider = new CodexAgentProvider(codexEnv() as unknown as AppEnv);
    const result = await provider.poll("sess_123");

    expect(result.status).toBe("completed");
    expect(result.result).toContain(
      "https://github.com/VortexNYC/pile/pull/42"
    );
    expect(result.prUrl).toBe("https://github.com/VortexNYC/pile/pull/42");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("maps in_progress to running and failed to failed", async () => {
    mockFetch([
      {
        url: "https://api.openai.com/v1/agents/sessions/sess_123",
        response: () => ({ id: "sess_123", status: "in_progress" }),
      },
      {
        url: /\/agents\/sessions\/sess_123\/items/,
        response: () => ({ data: [] }),
      },
    ]);

    const provider = new CodexAgentProvider(codexEnv() as unknown as AppEnv);
    const result = await provider.poll("sess_123");
    expect(result.status).toBe("running");
  });

  it("cancels by posting a cancel event", async () => {
    const fetchSpy = mockFetch([
      {
        url: "https://api.openai.com/v1/agents/sessions/sess_123/events",
        method: "POST",
        response: () => ({ id: "sess_123" }),
      },
    ]);

    const provider = new CodexAgentProvider(codexEnv() as unknown as AppEnv);
    await provider.cancel("sess_123");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.events[0].type).toBe("agent.session.input.cancel");
  });
});

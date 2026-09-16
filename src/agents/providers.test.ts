import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { CfAgentProvider } from "./cf-agent.js";
import { CursorAgentProvider } from "./cursor.js";
import { DevinAgentProvider } from "./devin.js";

function devinEnv(): WorkerEnv {
  return {
    ...env,
    DEVIN_ORG_ID: "devin-org",
    DEVIN_TOKEN: "devin-token",
    DAYTONA_API_KEY: "daytona-key",
    DAYTONA_API_URL: "https://daytona.test",
  };
}

function cursorEnv(): AppEnv {
  return {
    ...env,
    AGENT_PROVIDER_TOKEN: "cursor-token",
    AGENT_PROVIDER_CONFIG: JSON.stringify({ endpoint: "https://cursor.test" }),
  };
}

function flueEnv(): AppEnv {
  return {
    ...env,
    AGENT_PROVIDER_TOKEN: "flue-token",
    AGENT_PROVIDER_CONFIG: JSON.stringify({
      endpoint: "https://flue.test",
      agent: "engineering",
    }),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("agent providers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("devin", () => {
    it("poll maps terminal statuses and extracts pr details", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          session_id: "devin-123",
          status: "exit",
          status_detail: "merged",
          pull_requests: [
            {
              url: "https://github.com/VortexNYC/pile/pull/1",
              pr_state: "merged",
            },
          ],
        })
      );

      const provider = new DevinAgentProvider(devinEnv());
      const result = await provider.poll("devin-123");

      expect(result.status).toBe("completed");
      expect(result.result).toBe("merged");
      expect(result.prUrl).toBe("https://github.com/VortexNYC/pile/pull/1");
      expect(result.prState).toBe("merged");
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0]?.[0] ?? "")).toContain(
        "/sessions/devin-123"
      );
    });

    it("getState returns provider and compute", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          jsonResponse({
            session_id: "devin-123",
            status: "running",
            status_detail: "working",
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            items: [
              {
                id: "sandbox-1",
                name: "worker-devin-123",
                state: "started",
                labels: {
                  "vortex.session": "devin-123",
                },
              },
            ],
          })
        );

      const provider = new DevinAgentProvider(devinEnv());
      const state = await provider.getState("devin-123", "tracker-123");

      expect(state).not.toBeNull();
      if (!state) throw new Error("state is null");
      expect((state.provider as Record<string, string>).session_id).toBe(
        "devin-123"
      );
      expect((state.compute as { id: string }).id).toBe("sandbox-1");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("cursor", () => {
    it("poll maps status and finds branch with pr", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          id: "run-1",
          status: "RUNNING",
          result: "working",
          git: {
            branches: [
              {
                branch: "feature-1",
                prUrl: "https://github.com/VortexNYC/pile/pull/2",
              },
              { branch: "feature-2" },
            ],
          },
        })
      );

      const provider = new CursorAgentProvider(cursorEnv());
      const result = await provider.poll("agent-1/run-1");

      expect(result.status).toBe("running");
      expect(result.result).toBe("working");
      expect(result.prUrl).toBe("https://github.com/VortexNYC/pile/pull/2");
      expect(result.branch).toBe("feature-1");
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("cancel posts to the cancel endpoint", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const provider = new CursorAgentProvider(cursorEnv());
      await provider.cancel("agent-1/run-1");

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(String(fetchSpy.mock.calls[0]?.[0] ?? "")).toContain("/cancel");
    });

    it("parseWebhook maps nested agent/run payload to composite session id", () => {
      const provider = new CursorAgentProvider(cursorEnv());
      const parsed = provider.parseWebhook?.(
        {
          agent: { id: "agent-1", url: "https://cursor.test/agent-1" },
          run: { id: "run-9", status: "FINISHED" },
        },
        new Headers()
      );

      expect(parsed?.sessionId).toBe("agent-1/run-9");
      expect(parsed?.session?.status).toBe("completed");
      expect(parsed?.session?.url).toBe("https://cursor.test/agent-1");
    });

    it("parseWebhook accepts flat agentId/runId and extracts pr fields", () => {
      const provider = new CursorAgentProvider(cursorEnv());
      const parsed = provider.parseWebhook?.(
        {
          agentId: "agent-2",
          runId: "run-2",
          status: "RUNNING",
          prUrl: "https://github.com/org/repo/pull/5",
          branch: "cursor/run-2",
        },
        new Headers()
      );

      expect(parsed?.sessionId).toBe("agent-2/run-2");
      expect(parsed?.session?.status).toBe("running");
      expect(parsed?.session?.prUrl).toBe("https://github.com/org/repo/pull/5");
      expect(parsed?.session?.branch).toBe("cursor/run-2");
    });

    it("parseWebhook returns null for unrecognized payloads", () => {
      const provider = new CursorAgentProvider(cursorEnv());
      expect(
        provider.parseWebhook?.({ hello: "world" }, new Headers())
      ).toBeNull();
      expect(provider.parseWebhook?.(null, new Headers())).toBeNull();
    });
  });

  describe("flue", () => {
    it("poll sends authorization and maps completed settlement", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              role: "assistant",
              parts: [{ type: "text", text: "done" }],
            },
          ],
          settlements: [{ submissionId: "s1", outcome: "completed" }],
        })
      );

      const provider = new CfAgentProvider(flueEnv(), "flue");
      const result = await provider.poll("conv-1");

      expect(result.status).toBe("completed");
      expect(result.result).toBe("done");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const request = fetchSpy.mock.calls[0]?.[0] as Request;
      expect(request.headers.get("Authorization")).toBe("Bearer flue-token");
    });

    it("parseWebhook maps conversationId and settlement outcome", () => {
      const provider = new CfAgentProvider(flueEnv(), "flue");
      const parsed = provider.parseWebhook?.(
        { conversationId: "conv-9", outcome: "completed", result: "shipped" },
        new Headers()
      );

      expect(parsed?.sessionId).toBe("conv-9");
      expect(parsed?.session?.status).toBe("completed");
      expect(parsed?.session?.result).toBe("shipped");
    });

    it("parseWebhook maps aborted outcome to canceled", () => {
      const provider = new CfAgentProvider(flueEnv(), "flue");
      const parsed = provider.parseWebhook?.(
        { conversation_id: "conv-2", outcome: "aborted" },
        new Headers()
      );

      expect(parsed?.sessionId).toBe("conv-2");
      expect(parsed?.session?.status).toBe("canceled");
    });

    it("parseWebhook returns null without a conversation id", () => {
      const provider = new CfAgentProvider(flueEnv(), "flue");
      expect(
        provider.parseWebhook?.({ outcome: "completed" }, new Headers())
      ).toBeNull();
    });
  });
});

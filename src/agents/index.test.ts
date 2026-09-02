import { describe, expect, it } from "vitest";
import type { AppEnv } from "../platform/env.js";
import { MockAgentProvider } from "./harness.js";
import {
  dispatchAgent,
  getAgentProvider,
  registerAgentProvider,
} from "./index.js";

describe("agent providers", () => {
  it("throws for unknown provider", () => {
    expect(() => getAgentProvider("unknown", {} as AppEnv)).toThrow(
      "Unknown agent provider: unknown",
    );
  });

  it("registers and dispatches a mock provider", async () => {
    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "test-1",
        agentId: "mock",
        issueId: "issue-1",
        status: "created",
      }),
    });
    registerAgentProvider("mock", () => provider);

    const session = await dispatchAgent({} as AppEnv, "mock", "ws-1", {
      id: "issue-1",
      title: "Test",
      description: null,
    });

    expect(session.id).toBe("test-1");
    expect(session.agentId).toBe("mock");
    expect(session.issueId).toBe("issue-1");
  });

  it("polls a mock session", async () => {
    const provider = new MockAgentProvider("mock", {
      poll: (sessionId) => ({
        id: sessionId,
        agentId: "mock",
        issueId: "issue-1",
        status: "completed",
        result: "done",
      }),
    });
    registerAgentProvider("mock-poll", () => provider);

    const p = getAgentProvider("mock-poll", {} as AppEnv);
    const session = await p.poll("session-1");

    expect(session.id).toBe("session-1");
    expect(session.status).toBe("completed");
  });
});

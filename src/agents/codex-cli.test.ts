import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import type { GitIdentity, Issue } from "../types/workspace.js";
import { CodexCliAgentProvider } from "./codex-cli.js";

function cliEnv(overrides?: Partial<AppEnv>): AppEnv {
  return {
    DAYTONA_API_KEY: "daytona-key",
    CODEX_AUTH_JSON_B64: btoa(JSON.stringify({ access_token: "test" })),
    ...overrides,
  } as AppEnv;
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

function issueFixture(): Issue {
  return {
    id: "issue-1",
    title: "Add a thing",
    description: "do it",
    repo: "VortexNYC/pile",
    branch: "ISS-1-add-thing",
    identifier: "ISS-1",
    teamId: "team-1",
  } as unknown as Issue;
}

function gitIdentityFixture(): GitIdentity {
  return {
    repo: "VortexNYC/pile",
    name: "Vortex Agent",
    email: "agent@example.com",
    githubUsername: "vortex-agent",
  } as unknown as GitIdentity;
}

describe("CodexCliAgentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when auth is missing", async () => {
    const provider = new CodexCliAgentProvider(
      cliEnv({ CODEX_AUTH_JSON_B64: undefined })
    );
    await expect(
      provider.dispatch("org-1", issueFixture(), "gpt-reserve", {
        sessionId: "sess-1",
        gitIdentity: gitIdentityFixture(),
      })
    ).rejects.toThrow("CODEX_AUTH_JSON_B64 is not configured");
  });

  it("throws when Daytona is not configured", async () => {
    const provider = new CodexCliAgentProvider(
      cliEnv({ DAYTONA_API_KEY: undefined })
    );
    await expect(
      provider.dispatch("org-1", issueFixture(), "gpt-reserve", {
        sessionId: "sess-1",
        gitIdentity: gitIdentityFixture(),
      })
    ).rejects.toThrow("DAYTONA_API_KEY is not configured");
  });

  it("dispatches and starts a Daytona sandbox", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    const fetchSpy = mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        method: "GET",
        response: () => ({ items: [] }),
      },
      {
        url: "https://app.daytona.io/api/sandbox",
        method: "POST",
        response: () => ({
          id: sandboxId,
          name: "vortex-codex-sess1",
          state: "creating",
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        }),
      },
      {
        url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
        method: "GET",
        response: () => ({
          id: sandboxId,
          name: "vortex-codex-sess1",
          state: "started",
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        }),
      },
      {
        url: `${toolboxBase}/process/session`,
        method: "POST",
        response: () => ({ sessionId: "sess-1" }),
      },
      {
        url: `${toolboxBase}/process/session/sess-1/exec`,
        method: "POST",
        response: () => ({ cmdId: "cmd-1" }),
      },
    ]);

    const provider = new CodexCliAgentProvider(cliEnv());
    (
      provider as unknown as { githubToken: (repo: string) => Promise<string> }
    ).githubToken = vi.fn().mockResolvedValue("gh-token");

    const waitUntilCalls: Promise<unknown>[] = [];
    const result = await provider.dispatch(
      "org-1",
      issueFixture(),
      "gpt-reserve",
      {
        sessionId: "sess-1",
        gitIdentity: gitIdentityFixture(),
        waitUntil: (p) => waitUntilCalls.push(p),
      }
    );

    expect(result.id).toBe("sess-1");
    expect(result.status).toBe("created");
    expect(result.agentId).toBe("codex-cli");
    await Promise.all(waitUntilCalls);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === "https://app.daytona.io/api/sandbox" &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    expect(body.env.MODEL).toBe("gpt-reserve");
    expect(body.env.REPO).toBe("VortexNYC/pile");
    expect(body.labels["vortex.agent"]).toBe("codex-cli");
  });

  it("polls running while command is in progress", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-codex-sess1",
              state: "started",
              toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
              labels: { "vortex.session": "sess-1" },
            },
          ],
        }),
      },
      {
        url: `${toolboxBase}/process/session/sess-1`,
        response: () => ({
          sessionId: "sess-1",
          commands: [{ id: "cmd-1", command: "python3 /tmp/run.py" }],
        }),
      },
    ]);

    const provider = new CodexCliAgentProvider(cliEnv());
    const result = await provider.poll("sess-1");
    expect(result.status).toBe("running");
    expect(result.id).toBe("sess-1");
  });

  it("polls completed and extracts PR URL and branch from result", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-codex-sess1",
              state: "started",
              toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
              labels: { "vortex.session": "sess-1" },
            },
          ],
        }),
      },
      {
        url: `${toolboxBase}/process/session/sess-1`,
        response: () => ({
          sessionId: "sess-1",
          commands: [
            { id: "cmd-1", command: "python3 /tmp/run.py", exitCode: 0 },
          ],
        }),
      },
      {
        url: `${toolboxBase}/process/execute`,
        method: "POST",
        response: () => ({
          result: JSON.stringify({
            status: "completed",
            prUrl: "https://github.com/VortexNYC/pile/pull/42",
            branch: "ISS-1-add-thing",
            result: "Done",
          }),
          exitCode: 0,
        }),
      },
    ]);

    const provider = new CodexCliAgentProvider(cliEnv());
    const result = await provider.poll("sess-1");
    expect(result.status).toBe("completed");
    expect(result.prUrl).toBe("https://github.com/VortexNYC/pile/pull/42");
    expect(result.prState).toBe("open");
    expect(result.branch).toBe("ISS-1-add-thing");
    expect(result.result).toBe("Done");
  });

  it("polls failed when result status is failed", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-codex-sess1",
              state: "started",
              toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
              labels: { "vortex.session": "sess-1" },
            },
          ],
        }),
      },
      {
        url: `${toolboxBase}/process/session/sess-1`,
        response: () => ({
          sessionId: "sess-1",
          commands: [
            { id: "cmd-1", command: "python3 /tmp/run.py", exitCode: 1 },
          ],
        }),
      },
      {
        url: `${toolboxBase}/process/execute`,
        method: "POST",
        response: () => ({
          result: JSON.stringify({
            status: "failed",
            prUrl: "",
            branch: "ISS-1-add-thing",
            result: "lint failed",
          }),
          exitCode: 0,
        }),
      },
    ]);

    const provider = new CodexCliAgentProvider(cliEnv());
    const result = await provider.poll("sess-1");
    expect(result.status).toBe("failed");
    expect(result.result).toBe("lint failed");
    expect(result.prUrl).toBeNull();
  });

  it("cancels by deleting the sandbox", async () => {
    const sandboxId = "sb-1";
    const fetchSpy = mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-codex-sess1",
              state: "started",
              labels: { "vortex.session": "sess-1" },
            },
          ],
        }),
      },
      {
        url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
        method: "DELETE",
        response: () => ({}),
      },
    ]);

    const provider = new CodexCliAgentProvider(cliEnv());
    await provider.cancel("sess-1");

    const deleteCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === `https://app.daytona.io/api/sandbox/${sandboxId}` &&
        (init as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleteCall).toBeDefined();
  });
});

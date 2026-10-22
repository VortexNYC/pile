import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import type { GitIdentity, Issue } from "../types/workspace.js";
import { DevinCliAgentProvider } from "./devin-cli.js";
import { DOMAIN_REVIEW_PROMPT } from "./review-prompt.js";

function cliEnv(overrides?: Partial<AppEnv>): AppEnv {
  return {
    DAYTONA_API_KEY: "daytona-key",
    DEVIN_CLI_CREDENTIALS_B64: btoa('token = "devin-session-token$test"'),
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
        (typeof r.url === "string"
          ? url === r.url || url.startsWith(`${r.url}?`)
          : r.url.test(url)) &&
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
    // Provision file uploads and the lane.env chmod are routine — tests
    // that care about them read the calls off the spy directly.
    if (/\/files\/upload(-v2)?\?/.test(url) && method === "POST") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.endsWith("/process/execute") && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ exitCode: 0, result: "" }), {
          status: 200,
        })
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

/** Raw body of the upload-v2 call for one sandbox path (PILE-595). */
function uploadedBody(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  path: string
): string {
  const hit = fetchSpy.mock.calls.find(
    (call: unknown[]) =>
      String(call[0]).includes(
        `/files/upload-v2?path=${encodeURIComponent(path)}`
      ) && (call[1] as RequestInit | undefined)?.method === "POST"
  );
  return String((hit?.[1] as RequestInit | undefined)?.body ?? "");
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

const dispatchRoutes = (sandboxId: string) => {
  const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
  return [
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
        name: "vortex-devin-sess1",
        state: "creating",
        toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
      }),
    },
    {
      url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
      method: "GET",
      response: () => ({
        id: sandboxId,
        name: "vortex-devin-sess1",
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
  ];
};

async function laneEnvFor(credentials: string): Promise<string> {
  const fetchSpy = mockFetch(dispatchRoutes("sb-creds"));
  const provider = new DevinCliAgentProvider(
    cliEnv({ DEVIN_CLI_CREDENTIALS_B64: credentials })
  );
  (
    provider as unknown as {
      githubToken: (
        repo: string
      ) => Promise<{ token: string; expiresAt: string | null }>;
    }
  ).githubToken = vi
    .fn()
    .mockResolvedValue({ token: "gh-token", expiresAt: null });
  const waits: Promise<unknown>[] = [];
  await provider.dispatch("org-1", issueFixture(), "swe-2", {
    sessionId: "sess-1",
    gitIdentity: gitIdentityFixture(),
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  return uploadedBody(fetchSpy, "/tmp/pile/lane.env");
}

describe("DevinCliAgentProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when credentials are missing", async () => {
    const provider = new DevinCliAgentProvider(
      cliEnv({ DEVIN_CLI_CREDENTIALS_B64: undefined })
    );
    await expect(
      provider.dispatch("org-1", issueFixture(), "swe-2", {
        sessionId: "sess-1",
        gitIdentity: gitIdentityFixture(),
      })
    ).rejects.toThrow("DEVIN_CLI_CREDENTIALS_B64 is not configured");
  });

  it("throws when Daytona is not configured", async () => {
    const provider = new DevinCliAgentProvider(
      cliEnv({ DAYTONA_API_KEY: undefined })
    );
    await expect(
      provider.dispatch("org-1", issueFixture(), "swe-2", {
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
          name: "vortex-devin-sess1",
          state: "creating",
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        }),
      },
      {
        url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
        method: "GET",
        response: () => ({
          id: sandboxId,
          name: "vortex-devin-sess1",
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

    const provider = new DevinCliAgentProvider(cliEnv());
    (
      provider as unknown as {
        githubToken: (
          repo: string
        ) => Promise<{ token: string; expiresAt: string | null }>;
      }
    ).githubToken = vi
      .fn()
      .mockResolvedValue({ token: "gh-token", expiresAt: null });

    const waitUntilCalls: Promise<unknown>[] = [];
    const result = await provider.dispatch("org-1", issueFixture(), "swe-2", {
      sessionId: "sess-1",
      gitIdentity: gitIdentityFixture(),
      waitUntil: (p) => waitUntilCalls.push(p),
    });

    expect(result.id).toBe("sess-1");
    expect(result.status).toBe("created");
    expect(result.agentId).toBe("devin-cli");
    await Promise.all(waitUntilCalls);

    expect(fetchSpy).toHaveBeenCalledTimes(9);
    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === "https://app.daytona.io/api/sandbox" &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall![1] as RequestInit).body as string);
    // Env rides /tmp/pile/lane.env, not the create call (PILE-595).
    expect(body.env ?? {}).toEqual({});
    const laneEnv = uploadedBody(fetchSpy, "/tmp/pile/lane.env");
    expect(laneEnv).toContain("export MODEL='swe-2'");
    expect(laneEnv).toContain("export REPO='VortexNYC/pile'");
    expect(laneEnv).toContain("export DEVIN_CREDENTIALS_B64='");
    expect(laneEnv).not.toContain("PILE_LANE_RESTRICTED");
    expect(body.labels["vortex.agent"]).toBe("devin-cli");
  });

  it("forwards restricted lane mode and the net allowlist", async () => {
    const sandboxId = "sb-2";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    const sandbox = {
      id: sandboxId,
      name: "vortex-devin-sess2",
      toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
    };
    const fetchSpy = mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        method: "GET",
        response: () => ({ items: [] }),
      },
      {
        url: "https://app.daytona.io/api/sandbox",
        method: "POST",
        response: () => ({ ...sandbox, state: "creating" }),
      },
      {
        url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
        method: "GET",
        response: () => ({ ...sandbox, state: "started" }),
      },
      {
        url: `${toolboxBase}/process/session`,
        method: "POST",
        response: () => ({ sessionId: "sess-2" }),
      },
      {
        url: `${toolboxBase}/process/session/sess-2/exec`,
        method: "POST",
        response: () => ({ cmdId: "cmd-2" }),
      },
    ]);

    const provider = new DevinCliAgentProvider(
      cliEnv({ LANE_RESTRICTED: "true", LANE_NET_ALLOWLIST: "pkg.example.com" })
    );
    (
      provider as unknown as { githubToken: (repo: string) => Promise<string> }
    ).githubToken = vi.fn().mockResolvedValue("gh-token");

    const waitUntilCalls: Promise<unknown>[] = [];
    await provider.dispatch("org-1", issueFixture(), "swe-2", {
      sessionId: "sess-2",
      gitIdentity: gitIdentityFixture(),
      waitUntil: (p) => waitUntilCalls.push(p),
    });
    await Promise.all(waitUntilCalls);

    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === "https://app.daytona.io/api/sandbox" &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCall).toBeDefined();
    const laneEnv = uploadedBody(fetchSpy, "/tmp/pile/lane.env");
    expect(laneEnv).toContain("export PILE_LANE_RESTRICTED='1'");
    expect(laneEnv).toContain("export PILE_NET_ALLOWLIST='pkg.example.com'");
  });

  it("appends dispatch instructions to the prompt context", async () => {
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
          name: "vortex-devin-sess1",
          state: "creating",
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        }),
      },
      {
        url: `https://app.daytona.io/api/sandbox/${sandboxId}`,
        method: "GET",
        response: () => ({
          id: sandboxId,
          name: "vortex-devin-sess1",
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

    const provider = new DevinCliAgentProvider(cliEnv());
    (
      provider as unknown as {
        githubToken: (
          repo: string
        ) => Promise<{ token: string; expiresAt: string | null }>;
      }
    ).githubToken = vi
      .fn()
      .mockResolvedValue({ token: "gh-token", expiresAt: null });

    const result = await provider.dispatch("org-1", issueFixture(), "swe-2", {
      sessionId: "sess-1",
      gitIdentity: gitIdentityFixture(),
      instructions: "Only touch src/api — no deploys",
    });
    expect(result.id).toBe("sess-1");

    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === "https://app.daytona.io/api/sandbox" &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(createCall).toBeDefined();
    const prompt = uploadedBody(fetchSpy, "/tmp/pile/prompt.md");
    expect(prompt).toContain("## Dispatch instructions");
    expect(prompt).toContain("Only touch src/api — no deploys");
    expect(prompt).toContain(DOMAIN_REVIEW_PROMPT);
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
              name: "vortex-devin-sess1",
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

    const provider = new DevinCliAgentProvider(cliEnv());
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
              name: "vortex-devin-sess1",
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

    const provider = new DevinCliAgentProvider(cliEnv());
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
              name: "vortex-devin-sess1",
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
            result: "devin -p failed",
          }),
          exitCode: 0,
        }),
      },
    ]);

    const provider = new DevinCliAgentProvider(cliEnv());
    const result = await provider.poll("sess-1");
    expect(result.status).toBe("failed");
    expect(result.result).toBe("devin -p failed");
    expect(result.prUrl).toBeNull();
  });

  it("sendPrompt injects into /tmp/followups while the Daytona runner is busy", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    const fetchSpy = mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-devin-sess1",
              state: "started",
              toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
              labels: { "vortex.session": "sess-1" },
            },
          ],
        }),
      },
      {
        // The primary session still has an in-flight command — sendPrompt
        // must take the stdin-injection path, not spawn a second runner.
        url: `${toolboxBase}/process/session/sess-1`,
        response: () => ({
          sessionId: "sess-1",
          commands: [{ id: "cmd-1", command: "python3 /tmp/run.py" }],
        }),
      },
    ]);

    const provider = new DevinCliAgentProvider(cliEnv());
    const sent = await provider.sendPrompt(
      "sess-1",
      "also fix the flaky test",
      issueFixture(),
      null,
      { organizationId: "org-1" }
    );
    expect(sent).toBe(true);

    const followupUpload = fetchSpy.mock.calls.find(
      ([input]) =>
        /\/files\/upload(-v2)?\?/.test(String(input)) &&
        String(input).includes(encodeURIComponent("/tmp/followups/"))
    );
    expect(followupUpload).toBeDefined();
    // No new process session was created — the live runner consumed stdin.
    const sessionCreates = fetchSpy.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith("/process/session") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(sessionCreates).toHaveLength(0);
  });

  it("sendPrompt on an idle Daytona sandbox spawns a -fu process session", async () => {
    const sandboxId = "sb-1";
    const toolboxBase = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
    const fetchSpy = mockFetch([
      {
        url: "https://app.daytona.io/api/sandbox",
        response: () => ({
          items: [
            {
              id: sandboxId,
              name: "vortex-devin-sess1",
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
        url: `${toolboxBase}/process/session/sess-1-fu`,
        response: () => ({}),
        method: "GET",
      },
      {
        url: `${toolboxBase}/process/session`,
        method: "POST",
        response: () => ({ sessionId: "sess-1-fu-x" }),
      },
      {
        url: /\/process\/session\/sess-1-fu-.+\/exec$/,
        method: "POST",
        response: () => ({ cmdId: "cmd-fu" }),
      },
    ]);

    const provider = new DevinCliAgentProvider(cliEnv());
    const seam = provider as unknown as {
      followupPermissions: () => Promise<unknown>;
      githubToken: (
        repo: string
      ) => Promise<{ token: string; expiresAt: string | null }>;
    };
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "enabled",
      push: "enabled",
    });
    seam.githubToken = vi
      .fn()
      .mockResolvedValue({ token: "gh-token", expiresAt: null });

    const sent = await provider.sendPrompt(
      "sess-1",
      "keep going",
      issueFixture(),
      null,
      { organizationId: "org-1" }
    );
    expect(sent).toBe(true);

    const sessionCreate = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/process/session") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(sessionCreate).toBeDefined();
    expect(
      JSON.parse((sessionCreate![1] as RequestInit).body as string).sessionId
    ).toContain("sess-1-fu-");
    const execCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        /\/process\/session\/sess-1-fu-.+\/exec$/.test(String(input)) &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(execCall).toBeDefined();
    expect(
      (
        JSON.parse((execCall![1] as RequestInit).body as string) as {
          command: string;
        }
      ).command
    ).toBe(". /tmp/pile/lane.env && python3 /tmp/pile/run.py");
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
              name: "vortex-devin-sess1",
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

    const provider = new DevinCliAgentProvider(cliEnv());
    await provider.cancel("sess-1");

    const deleteCall = fetchSpy.mock.calls.find(
      ([input, init]) =>
        String(input) === `https://app.daytona.io/api/sandbox/${sandboxId}` &&
        (init as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleteCall).toBeDefined();
  });

  // DEVIN_CLI_CREDENTIALS_B64 accepts either the base64 blob prod stores or
  // a raw credentials.toml pasted into a secret — normalizeCredentialsB64
  // encodes the latter so the runner's write_devin_home always decodes.
  describe("credential normalization", () => {
    it("base64-encodes a raw credentials.toml", async () => {
      const raw = 'token = "raw-toml-secret"';
      const laneEnv = await laneEnvFor(raw);
      expect(laneEnv).toContain(`export DEVIN_CREDENTIALS_B64='${btoa(raw)}'`);
    });

    it("passes an already-base64 credential blob through unchanged", async () => {
      const b64 = btoa('token = "already-encoded"');
      const laneEnv = await laneEnvFor(b64);
      expect(laneEnv).toContain(`export DEVIN_CREDENTIALS_B64='${b64}'`);
      // not double-encoded
      expect(laneEnv).not.toContain(btoa(b64));
    });
  });

  it("fails provision when sandbox compute hangs instead of stalling forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Only Daytona calls hang — session activity writes go through the DO
      // binding (absent here) and no-op.
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        if (String(input).includes("app.daytona.io")) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      });

      const provider = new DevinCliAgentProvider(cliEnv());
      (
        provider as unknown as {
          githubToken: (
            repo: string
          ) => Promise<{ token: string; expiresAt: string | null }>;
        }
      ).githubToken = vi
        .fn()
        .mockResolvedValue({ token: "gh-token", expiresAt: null });

      const waitUntilCalls: Promise<unknown>[] = [];
      const result = await provider.dispatch("org-1", issueFixture(), "swe-2", {
        sessionId: "sess-hang",
        gitIdentity: gitIdentityFixture(),
        waitUntil: (p) => waitUntilCalls.push(p),
      });
      expect(result.status).toBe("created");
      expect(waitUntilCalls).toHaveLength(1);

      const assertion = expect(waitUntilCalls[0]).rejects.toThrow(
        "devin-cli provision timed out"
      );
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

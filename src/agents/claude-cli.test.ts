import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import type { GitIdentity, Issue } from "../types/workspace.js";
import { ClaudeCliAgentProvider } from "./claude-cli.js";

function cliEnv(overrides?: Partial<AppEnv>): AppEnv {
  return {
    DAYTONA_API_KEY: "daytona-key",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-default",
    ...overrides,
  } as AppEnv;
}

const issue = {
  id: "issue-1",
  title: "Review a thing",
  description: "review it",
  repo: "VortexNYC/pile",
  branch: "ISS-1-review",
  identifier: "ISS-1",
  teamId: "team-1",
} as unknown as Issue;

const gitIdentity = {
  repo: "VortexNYC/pile",
  name: "Vortex Agent",
  email: "agent@example.com",
  githubUsername: "vortex-agent",
} as unknown as GitIdentity;

function mockDaytona() {
  const sandboxId = "sb-1";
  const toolbox = `https://proxy.app.daytona.io/toolbox/${sandboxId}`;
  const sandbox = {
    id: sandboxId,
    name: "vortex-claude-sess1",
    toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
  };
  const routes: Array<[string, string, unknown]> = [
    ["GET", "https://app.daytona.io/api/sandbox", { items: [] }],
    [
      "POST",
      "https://app.daytona.io/api/sandbox",
      { ...sandbox, state: "creating" },
    ],
    [
      "GET",
      `https://app.daytona.io/api/sandbox/${sandboxId}`,
      { ...sandbox, state: "started" },
    ],
    ["POST", `${toolbox}/process/session`, { sessionId: "sess-1" }],
    ["POST", `${toolbox}/process/session/sess-1/exec`, { cmdId: "cmd-1" }],
  ];
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = routes.find(([m, u]) => m === method && u === String(input));
    return Promise.resolve(
      hit
        ? new Response(JSON.stringify(hit[2]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response("not found", { status: 404 })
    );
  });
}

async function dispatchEnv(
  env: AppEnv,
  purpose?: string
): Promise<Record<string, string>> {
  const fetchSpy = mockDaytona();
  const provider = new ClaudeCliAgentProvider(env);
  (
    provider as unknown as { githubToken: (repo: string) => Promise<string> }
  ).githubToken = vi.fn().mockResolvedValue("gh-token");
  const pending: Promise<unknown>[] = [];
  const result = await provider.dispatch("org-1", issue, "sonnet", {
    sessionId: "sess-1",
    gitIdentity,
    purpose,
    waitUntil: (p) => pending.push(p),
  });
  expect(result.agentId).toBe("claude-cli");
  await Promise.all(pending);
  const create = fetchSpy.mock.calls.find(
    ([input, init]) =>
      String(input) === "https://app.daytona.io/api/sandbox" &&
      (init as RequestInit | undefined)?.method === "POST"
  );
  expect(create).toBeDefined();
  const body = JSON.parse((create![1] as RequestInit).body as string) as {
    env: Record<string, string>;
  };
  return body.env;
}

describe("ClaudeCliAgentProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when no token or pool is configured", async () => {
    const provider = new ClaudeCliAgentProvider(
      cliEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined })
    );
    await expect(
      provider.dispatch("org-1", issue, "sonnet", {
        sessionId: "sess-1",
        gitIdentity,
      })
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN is not configured");
  });

  it("passes the configured subscription token to the sandbox", async () => {
    const env = await dispatchEnv(cliEnv());
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-default");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MODEL).toBe("sonnet");
  });

  it("rides the review-scoped subscription for review lanes", async () => {
    const pool = JSON.stringify([
      {
        kind: "claudeSubscription",
        secret: "sk-ant-oat01-review",
        purposes: ["review"],
      },
      { kind: "anthropicApiKey", secret: "sk-ant-api03-fallback" },
    ]);
    const review = await dispatchEnv(
      cliEnv({ AGENT_CREDENTIAL_POOL: pool }),
      "review"
    );
    expect(review.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-review");

    vi.restoreAllMocks();
    const other = await dispatchEnv(cliEnv({ AGENT_CREDENTIAL_POOL: pool }));
    expect(other.ANTHROPIC_API_KEY).toBe("sk-ant-api03-fallback");
    expect(other.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("writes credentials.json pool entries via CLAUDE_CREDENTIALS_JSON_B64", async () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-a",
        refreshToken: "sk-ant-ort01-r",
        expiresAt: Date.now() - 1000,
      },
    };
    const env = await dispatchEnv(
      cliEnv({
        AGENT_CREDENTIAL_POOL: JSON.stringify([
          { kind: "claudeSubscription", secret: JSON.stringify(creds) },
        ]),
      })
    );
    expect(
      JSON.parse(atob(env.CLAUDE_CREDENTIALS_JSON_B64 ?? "")) as unknown
    ).toEqual(creds);
  });

  it("falls back to the configured token when the pool is exhausted", async () => {
    const env = await dispatchEnv(
      cliEnv({
        AGENT_CREDENTIAL_POOL: JSON.stringify([
          { kind: "claudeSubscription", secret: "not-a-credential" },
        ]),
      })
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-default");
  });

  it("reports pool expiry state from health", async () => {
    const provider = new ClaudeCliAgentProvider(
      cliEnv({
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        AGENT_CREDENTIAL_POOL: JSON.stringify([
          { kind: "claudeSubscription", secret: "garbage", label: "dead" },
        ]),
      })
    );
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.message).toContain("dead (claudeSubscription): invalid");
  });
});

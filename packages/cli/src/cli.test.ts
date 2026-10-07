import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runCli } from "./cli.js";

function createMockCaptureFetch({
  failToken = false,
}: {
  failToken?: boolean;
} = {}) {
  return vi.fn().mockImplementation((url, init) => {
    const requestUrl = new URL(
      typeof url === "string" ? url : (url as URL).href
    );
    const pathname = requestUrl.pathname;
    const method =
      init && typeof init === "object" && "method" in init
        ? String(init.method)
        : "GET";

    if (pathname === "/support/capture/token" && method === "POST") {
      if (failToken) {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: "session-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/support/capture/metadata" && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/support/capture/upload-session" && method === "POST") {
      const body =
        init && typeof init === "object" && typeof init.body === "string"
          ? JSON.parse(init.body as string)
          : {};
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uploadUrl: `/support/capture/upload/session-1/${body.attachmentType}/${encodeURIComponent(body.fileName ?? body.attachmentType)}`,
            r2Key: `session-1/${body.attachmentType}`,
            sessionId: "session-1",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }
    if (
      pathname.startsWith("/support/capture/upload/session-1/") &&
      method === "POST"
    ) {
      return Promise.resolve(
        new Response(JSON.stringify({ r2Key: "r2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/support/capture/finalize" && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ticketId: "ticket-1",
            shareUrl: "https://example.com/share/ticket-1",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function createMockSpawn({
  exitCode = 0,
  stdout = "hello\n",
  stderr = "",
}: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
} = {}) {
  let stdoutEmit: ((data: Buffer) => void) | undefined;
  let stderrEmit: ((data: Buffer) => void) | undefined;
  let closeEmit: ((code: number | null) => void) | undefined;

  const child = {
    stdout: {
      on(_event: "data", cb: (data: Buffer) => void) {
        stdoutEmit = cb;
      },
    },
    stderr: {
      on(_event: "data", cb: (data: Buffer) => void) {
        stderrEmit = cb;
      },
    },
    on(event: "close", cb: (code: number | null) => void) {
      if (event === "close") closeEmit = cb;
    },
  };

  Promise.resolve().then(() => {
    if (stdout.length > 0) stdoutEmit?.(Buffer.from(stdout));
    if (stderr.length > 0) stderrEmit?.(Buffer.from(stderr));
    closeEmit?.(exitCode);
  });

  return child;
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function createDispatchFollowFetch(states: readonly unknown[]) {
  let polls = 0;
  return vi.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
    const pathname = new URL(typeof url === "string" ? url : url.href).pathname;
    if (pathname.endsWith("/dispatch") && init?.method === "POST") {
      return jsonResponse({ id: "sess-1", status: "created" }, 201);
    }
    if (pathname.endsWith("/agent/sessions/sess-1/state")) {
      const state = states[Math.min(polls, states.length - 1)];
      polls += 1;
      return state === undefined
        ? jsonResponse({ message: "no live state" }, 400)
        : jsonResponse(state);
    }
    if (pathname.endsWith("/agent/sessions/sess-1")) {
      return jsonResponse({ id: "sess-1", status: "running", prUrl: null });
    }
    return jsonResponse({ message: "unexpected" }, 404);
  });
}

describe("CLI integration", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pile-cli-"));
    originalHome = process.env.HOME;
    originalApiKey = process.env.PILE_API_KEY;
    process.env.HOME = home;
    process.env.PILE_API_KEY = "test-api-key";
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.PILE_API_KEY = originalApiKey;
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a named command for issues list", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issues: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(["issues", "list", "--workspace", "ws-1"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/issues");
    expect(init.method).toBe("GET");
    expect(init.headers.get("Authorization")).toBe("Bearer test-api-key");
    spy.mockRestore();
  });

  it("runs a named command with body flags", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "i1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      ["issues", "create", "--workspace", "ws-1", "--title", "Hello"],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/issues");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Hello" });
    spy.mockRestore();
  });

  it("issues update forwards --pr-url and --pr-state in the PATCH body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "i1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "issues",
        "update",
        "ISS-1",
        "--workspace",
        "ws-1",
        "--pr-url",
        "https://github.com/VortexNYC/pile/pull/316",
        "--pr-state",
        "open",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/issues/ISS-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      prUrl: "https://github.com/VortexNYC/pile/pull/316",
      prState: "open",
    });
    spy.mockRestore();
  });

  it("memberships invite posts to the invitations endpoint with a default role", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "inv-1", status: "pending" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "memberships",
        "invite",
        "--workspace",
        "ws-1",
        "--email",
        "new@example.com",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/invitations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "new@example.com",
      role: "member",
    });
    spy.mockRestore();
  });

  it("memberships invite forwards role and team flags", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "inv-1", status: "pending" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "memberships",
        "invite",
        "--workspace",
        "ws-1",
        "--email",
        "new@example.com",
        "--role",
        "admin",
        "--team",
        "team-1",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      email: "new@example.com",
      role: "admin",
      teamId: "team-1",
    });
    spy.mockRestore();
  });

  it("runs a nested command with positional params", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "c1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "issues",
        "comments",
        "get",
        "issue-1",
        "comment-1",
        "--workspace",
        "ws-1",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [URL, { method: string }];
    expect(url.pathname).toBe(
      "/workspaces/ws-1/issues/issue-1/comments/comment-1"
    );
    expect(init.method).toBe("GET");
    spy.mockRestore();
  });

  it("makes an authorized GET request and prints JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(["request", "GET", "/workspaces"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers },
    ];
    expect(url.pathname).toBe("/workspaces");
    expect(init.method).toBe("GET");
    expect(init.headers.get("Authorization")).toBe("Bearer test-api-key");
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ workspaces: [] }, null, 2)
    );

    spy.mockRestore();
  });

  it("runs capture run, uploads console logs and video, and finalizes", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "pile-capture-"));
    writeFileSync(
      join(artifactsDir, "video.webm"),
      new Uint8Array([0, 0, 0, 24])
    );

    const mockFetch = createMockCaptureFetch();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "capture",
        "run",
        "--public-key",
        "pk-test",
        "--command",
        "echo hello",
        "--artifacts-dir",
        artifactsDir,
        "--title",
        "CLI capture run test",
      ],
      { fetch: mockFetch, spawn: () => createMockSpawn() }
    );

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    const finalizeCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname ===
          "/support/capture/finalize" &&
        init &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "POST"
    );
    expect(finalizeCall).toBeDefined();
    expect(spy).toHaveBeenLastCalledWith(
      JSON.stringify(
        {
          ticketId: "ticket-1",
          shareUrl: "https://example.com/share/ticket-1",
        },
        null,
        2
      )
    );

    rmSync(artifactsDir, { recursive: true, force: true });
    spy.mockRestore();
  });

  it("capture run returns the wrapped command exit code and still finalizes", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "pile-capture-"));
    writeFileSync(
      join(artifactsDir, "video.webm"),
      new Uint8Array([0, 0, 0, 24])
    );

    const mockFetch = createMockCaptureFetch();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "capture",
        "run",
        "--public-key",
        "pk-test",
        "--command",
        "exit 7",
        "--artifacts-dir",
        artifactsDir,
        "--title",
        "Failing command test",
      ],
      {
        fetch: mockFetch,
        spawn: () => createMockSpawn({ exitCode: 7, stdout: "failed\n" }),
      }
    );

    expect(exitCode).toBe(7);
    const finalizeCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname ===
          "/support/capture/finalize" &&
        init &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "POST"
    );
    expect(finalizeCall).toBeDefined();

    rmSync(artifactsDir, { recursive: true, force: true });
    spy.mockRestore();
  });

  it("capture run returns 1 when the token request fails", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "pile-capture-"));
    writeFileSync(
      join(artifactsDir, "video.webm"),
      new Uint8Array([0, 0, 0, 24])
    );

    const mockFetch = createMockCaptureFetch({ failToken: true });

    const exitCode = await runCli(
      [
        "capture",
        "run",
        "--public-key",
        "pk-test",
        "--command",
        "echo hello",
        "--artifacts-dir",
        artifactsDir,
      ],
      { fetch: mockFetch, spawn: () => createMockSpawn() }
    );

    expect(exitCode).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();

    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("capture run rejects a missing public key", async () => {
    const exitCode = await runCli([
      "capture",
      "run",
      "--command",
      "echo hello",
    ]);
    expect(exitCode).toBe(1);
  });

  it("capture run rejects a missing command", async () => {
    const exitCode = await runCli(["capture", "run", "--public-key", "pk"]);
    expect(exitCode).toBe(1);
  });

  it("lists support tickets for a workspace", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tickets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      ["support", "tickets", "list", "--workspace", "ws-1"],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/support/tickets");
    expect(init.method).toBe("GET");
    expect(init.headers.get("Authorization")).toBe("Bearer test-api-key");
    spy.mockRestore();
  });

  it("creates a support ticket through the CLI", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "st-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "support",
        "tickets",
        "create",
        "--workspace",
        "ws-1",
        "--customer-id",
        "c-1",
        "--title",
        "I need help",
        "--message",
        "Something is broken",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body: string },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/support/tickets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      customerId: "c-1",
      title: "I need help",
      message: "Something is broken",
    });
    spy.mockRestore();
  });

  it("returns a non-zero exit code for HTTP errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );

    const exitCode = await runCli(["issues", "list", "--workspace", "ws-1"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(1);
  });

  it("logs in and stores the token", async () => {
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      const requestUrl = new URL(
        typeof url === "string" ? url : (url as URL).href
      );
      const pathname = requestUrl.pathname;
      const method =
        init && typeof init === "object" && "method" in init
          ? String(init.method)
          : "GET";

      if (pathname === "/api/auth/sign-in/email" && method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "u-1" } }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "session_token=abc123; Path=/; HttpOnly",
            },
          })
        );
      }
      if (pathname === "/workspaces/ws-1/tokens" && method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "t-1",
              organizationId: "ws-1",
              name: "cli",
              token: "api-token-1",
              permissions: "admin",
              createdAt: "2026-01-01T00:00:00Z",
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "pile-auth-"));
    process.env.HOME = tmpDir;
    const configPath = join(tmpDir, ".pile", "config.json");
    process.env.PILE_EMAIL = "user@example.com";
    process.env.PILE_PASSWORD = "secret";

    const exitCode = await runCli(["auth", "login", "--workspace", "ws-1"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(0);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      apiKey?: string;
      baseUrl?: string;
    };
    expect(written.apiKey).toBe("api-token-1");
    expect(written.baseUrl).toBe("http://127.0.0.1:8787");
  });

  it("login requests the caller's full permission set with a CSRF origin", async () => {
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      const requestUrl = new URL(
        typeof url === "string" ? url : (url as URL).href
      );
      const pathname = requestUrl.pathname;
      const method =
        init && typeof init === "object" && "method" in init
          ? String(init.method)
          : "GET";

      if (pathname === "/api/auth/sign-in/email" && method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ user: { id: "u-1" } }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "session_token=abc123; Path=/; HttpOnly",
            },
          })
        );
      }
      if (pathname === "/workspaces/ws-1/tokens" && method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "t-1",
              organizationId: "ws-1",
              name: "cli",
              token: "api-token-1",
              permissions: "read,write",
              createdAt: "2026-01-01T00:00:00Z",
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "pile-auth-"));
    process.env.HOME = tmpDir;
    process.env.PILE_EMAIL = "user@example.com";
    process.env.PILE_PASSWORD = "secret";

    const exitCode = await runCli(["auth", "login", "--workspace", "ws-1"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(0);
    const tokenCall = mockFetch.mock.calls.find(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname ===
        "/workspaces/ws-1/tokens"
    );
    expect(tokenCall).toBeDefined();
    const [, tokenInit] = tokenCall as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
      },
    ];
    // Cookie-authed POSTs must assert the target origin or the server's CSRF
    // check rejects the token request.
    expect(tokenInit.headers.Origin).toBe("http://127.0.0.1:8787");
    expect(tokenInit.headers.Cookie).toBe("session_token=abc123");
    // Ask for the full set — the server clamps to the caller's workspace
    // role, so members land on read,write instead of getting a 403.
    expect(JSON.parse(tokenInit.body)).toEqual({
      name: "cli",
      permissions: ["read", "write", "admin"],
    });
  });

  it("returns the current session", async () => {
    process.env.PILE_SESSION = "session_token=abc123";
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const exitCode = await runCli(["auth", "status"], { fetch: mockFetch });

    delete process.env.PILE_SESSION;
    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/auth/get-session",
      expect.objectContaining({
        headers: { Cookie: "session_token=abc123" },
      })
    );
  });

  it("logs out and clears the session", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const tmpDir = mkdtempSync(join(tmpdir(), "pile-auth-"));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, ".pile"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pile", "config.json"),
      JSON.stringify({ session: "session_token=abc123" })
    );

    const exitCode = await runCli(["auth", "logout"], { fetch: mockFetch });

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/auth/sign-out",
      expect.objectContaining({
        method: "POST",
        headers: { Cookie: "session_token=abc123" },
      })
    );
    const written = JSON.parse(
      readFileSync(join(tmpDir, ".pile", "config.json"), "utf8")
    ) as { session?: string };
    expect(written.session).toBeUndefined();
  });

  it("rejects login when sign-in fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const exitCode = await runCli(
      [
        "auth",
        "login",
        "--email",
        "user@example.com",
        "--password",
        "secret",
        "--workspace",
        "ws-1",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(1);
  });

  it("init signs up, onboards a workspace, and stores config", async () => {
    process.env.HOME = home;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("no account", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { id: "u-1" } }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: {} }), {
          status: 200,
          headers: {
            "set-cookie":
              "__Secure-better-auth.session_token=tok123; Path=/; HttpOnly",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspace: { id: "org-new" },
            team: { id: "team-1" },
            token: "pil_test",
          }),
          { status: 201 }
        )
      );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "init",
        "--email",
        "new@co.dev",
        "--password",
        "hunter2hunter2",
        "--name",
        "New Co",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const [onboardUrl, onboardInit] = mockFetch.mock.calls[3] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(new URL(onboardUrl).pathname).toBe("/workspaces/onboard");
    expect(onboardInit.method).toBe("POST");
    expect(onboardInit.headers.Cookie).toContain("session_token=tok123");
    const config = JSON.parse(
      readFileSync(join(home, ".pile", "config.json"), "utf8")
    ) as { apiKey?: string; workspace?: string };
    expect(config.apiKey).toBe("pil_test");
    expect(config.workspace).toBe("org-new");
    spy.mockRestore();
  });

  it("init reuses an existing account without signing up", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: {} }), {
          status: 200,
          headers: {
            "set-cookie": "__Secure-better-auth.session_token=tok9; Path=/",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspace: { id: "org-ex" },
            team: { id: "team-1" },
            token: "pil_ex",
          }),
          { status: 201 }
        )
      );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "init",
        "--email",
        "existing@co.dev",
        "--password",
        "hunter2hunter2",
        "--name",
        "Acme",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("feedback files a ticket into the Pile workspace", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, ticketId: "t-1", ticketNumber: 42 }),
          { status: 201 }
        )
      );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "feedback",
        "--message",
        "the init flow rocks and onboarding was smooth",
        "--email",
        "reporter@co.dev",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(new URL(url).pathname).toBe("/support/feedback");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as {
      subject: string;
      text: string;
      fromEmail: string;
      context: { client: string; version: string; os: string };
    };
    expect(body.subject).toBe("the init flow rocks and onboarding was smooth");
    expect(body.fromEmail).toBe("reporter@co.dev");
    expect(body.context.client).toBe("pile-cli");
    expect(body.context.os).toBeTruthy();
    spy.mockRestore();
  });

  it("feedback rejects a missing message", async () => {
    const exitCode = await runCli(["feedback"], { fetch: vi.fn() });
    expect(exitCode).toBe(1);
  });

  it("feedback rejects a missing email", async () => {
    const prev = process.env.PILE_EMAIL;
    delete process.env.PILE_EMAIL;
    const exitCode = await runCli(
      ["feedback", "--message", "this is long enough but has no email"],
      { fetch: vi.fn() }
    );
    process.env.PILE_EMAIL = prev;
    expect(exitCode).toBe(1);
  });

  it("dispatch --follow exits 0 once the lane opens a PR", async () => {
    const mockFetch = createDispatchFollowFetch([
      { session: { status: "running", prUrl: null } },
      {
        session: { status: "running", prUrl: "https://github.com/o/r/pull/1" },
      },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "issues",
        "dispatch",
        "--workspace",
        "ws-1",
        "--follow",
        "ISS-1",
        "--interval",
        "1",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(url.pathname).toBe("/workspaces/ws-1/issues/ISS-1/dispatch");
    expect(init.body).toBeUndefined();
    expect(spy).toHaveBeenCalledWith("pr: https://github.com/o/r/pull/1");
    spy.mockRestore();
  });

  it("dispatch --follow exits 1 when the lane fails", async () => {
    const mockFetch = createDispatchFollowFetch([
      { session: { status: "failed", prUrl: null } },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      ["issues", "dispatch", "ISS-1", "--workspace", "ws-1", "--follow"],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("dispatch --follow falls back to the session record and times out with 124", async () => {
    const mockFetch = createDispatchFollowFetch([undefined]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "issues",
        "dispatch",
        "ISS-1",
        "--workspace",
        "ws-1",
        "--follow",
        "--timeout",
        "0",
        "--interval",
        "1",
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(124);
    expect(log).toHaveBeenCalledWith("status: running");
    const fallbackReq = mockFetch.mock.calls
      .map(([url]) => new URL(typeof url === "string" ? url : url.href))
      .find((u) => u.pathname === "/workspaces/ws-1/agent/sessions/sess-1");
    expect(fallbackReq?.searchParams.get("summary")).toBe("1");
    log.mockRestore();
    error.mockRestore();
  });

  it("dispatches a batch from repeated --item flags", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          batchId: "b1",
          results: [
            { issueId: "ISS-1", sessionId: "s1", status: "created" },
            { issueId: "ISS-2", sessionId: "s2", status: "waiting" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      [
        "agent",
        "dispatch-batch",
        "--workspace",
        "ws-1",
        "--item",
        "ISS-1",
        "--item",
        '{"issueId":"ISS-2","queuedAfter":"ISS-1"}',
      ],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(new URL(url).pathname).toBe("/workspaces/ws-1/agent/dispatch-batch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ issueId: "ISS-1" }, { issueId: "ISS-2", queuedAfter: "ISS-1" }],
    });
    spy.mockRestore();
  });

  it("dispatches a batch from --file", async () => {
    const file = join(home, "batch.json");
    writeFileSync(
      file,
      JSON.stringify({ items: [{ issueId: "ISS-9", agentId: "devin" }] })
    );
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          batchId: "b2",
          results: [{ issueId: "ISS-9", sessionId: "s9" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(
      ["agent", "dispatch-batch", "--workspace", "ws-1", "--file", file],
      { fetch: mockFetch }
    );

    expect(exitCode).toBe(0);
    const [, init] = mockFetch.mock.calls[0] as [
      URL,
      { method: string; body?: string },
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ issueId: "ISS-9", agentId: "devin" }],
    });
    spy.mockRestore();
  });

  it("dispatch-batch without items exits 1", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await runCli(
      ["agent", "dispatch-batch", "--workspace", "ws-1"],
      { fetch: vi.fn() }
    );

    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("tui-check exits 0 when the OpenTUI probe succeeds", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await runCli(["tui-check"], {
      probeTui: () => Promise.resolve(),
    });

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
    logSpy.mockRestore();
  });

  it("tui-check exits 1 when OpenTUI cannot load", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const exitCode = await runCli(["tui-check"], {
      probeTui: () =>
        Promise.reject(
          new Error(
            "Cannot find module '@opentui/core' from '/$bunfs/root/pile'"
          )
        ),
    });

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("tui-check"));
    errorSpy.mockRestore();
  });

  it("rejects an unknown command", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issues: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const exitCode = await runCli(["nope", "--workspace", "ws-1"], {
      fetch: mockFetch,
    });

    expect(exitCode).toBe(1);
  });
});

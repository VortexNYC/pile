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

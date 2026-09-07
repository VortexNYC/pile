import { mkdtempSync, rmSync } from "node:fs";
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

describe("CLI integration", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "issuetracker-cli-"));
    originalHome = process.env.HOME;
    originalApiKey = process.env.ISSUETRACKER_API_KEY;
    process.env.HOME = home;
    process.env.ISSUETRACKER_API_KEY = "test-api-key";
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.ISSUETRACKER_API_KEY = originalApiKey;
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
});

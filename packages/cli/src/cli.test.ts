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

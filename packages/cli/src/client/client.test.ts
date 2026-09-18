import { describe, expect, it, vi } from "vitest";

import {
  createPileClient,
  isPileErrorCodeOf,
  PileRequestError,
  toPileError,
  unwrap,
} from "./index.js";

type FetchFn = (request: Request) => Promise<Response>;

describe("Pile client", () => {
  it("lists workspaces", async () => {
    const mockFetch = vi.fn<FetchFn>().mockResolvedValue(
      new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (request) => mockFetch(request),
    });

    const { data } = await client.GET("/workspaces", {});
    expect(data).toEqual({ workspaces: [] });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [Request];
    expect(url.url).toBe("https://example.com/workspaces");
    expect(url.headers.get("Authorization")).toBe("Bearer test-key");
  });

  it("creates an issue", async () => {
    const mockFetch = vi.fn<FetchFn>().mockResolvedValue(
      new Response(JSON.stringify({ id: "i-1", identifier: "ISS-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (request) => mockFetch(request),
    });

    const { data } = await client.POST("/workspaces/{organizationId}/issues", {
      params: { path: { organizationId: "org-1" } },
      body: { title: "Bug", teamId: "team-1", priority: "medium" },
    });
    expect(data).toEqual({ id: "i-1", identifier: "ISS-1" });
    const [url] = mockFetch.mock.calls[0] as [Request];
    expect(url.url).toBe("https://example.com/workspaces/org-1/issues");
  });

  it("returns an error for non-OK responses", async () => {
    const mockFetch = vi.fn<FetchFn>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "test-key",
      fetch: (request) => mockFetch(request),
    });

    const { data, error } = await client.GET("/workspaces", {});
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
  });
});

describe("auth options", () => {
  it("sends a session cookie", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(Response.json({ workspaces: [] }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      auth: { type: "session", cookie: "better-auth.session_token=abc" },
      fetch: (request) => mockFetch(request),
    });
    await client.GET("/workspaces", {});
    const [request] = mockFetch.mock.calls[0] as [Request];
    expect(request.headers.get("Cookie")).toBe("better-auth.session_token=abc");
    expect(request.headers.get("Authorization")).toBeNull();
  });

  it("uses credentials: include for browser sessions", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(Response.json({ workspaces: [] }));
    const inits: unknown[] = [];
    class CapturingRequest extends Request {
      constructor(input: string | URL | Request, init?: RequestInit) {
        super(input, init);
        if (init) inits.push(init);
      }
    }
    const client = createPileClient({
      baseUrl: "https://example.com",
      auth: { type: "browser" },
      Request: CapturingRequest as typeof Request,
      fetch: (request) => mockFetch(request),
    });
    await client.GET("/workspaces", {});
    expect(inits[0]).toMatchObject({ credentials: "include" });
  });

  it("requires some form of auth", () => {
    expect(() => createPileClient({ baseUrl: "https://example.com" })).toThrow(
      /apiKey/u
    );
  });
});

const noSleep = () => Promise.resolve();

describe("retry", () => {
  it("retries idempotent requests on 503 and honours maxRetries", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ workspaces: [] }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      retry: { maxRetries: 2, sleep: noSleep },
      fetch: (request) => mockFetch(request),
    });
    const { data } = await client.GET("/workspaces", {});
    expect(data).toEqual({ workspaces: [] });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      retry: { maxRetries: 1, sleep: noSleep },
      fetch: (request) => mockFetch(request),
    });
    const { response } = await client.GET("/workspaces", {});
    expect(response.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry POST by default", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      retry: { sleep: noSleep },
      fetch: (request) => mockFetch(request),
    });
    await client.POST("/workspaces/{organizationId}/issues", {
      params: { path: { organizationId: "org-1" } },
      body: { title: "Bug", teamId: "team-1", priority: "medium" },
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("retries network failures and respects Retry-After", async () => {
    const sleep = vi
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const mockFetch = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response("slow", { status: 429, headers: { "Retry-After": "1" } })
      )
      .mockResolvedValueOnce(Response.json({ workspaces: [] }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      retry: { maxRetries: 3, sleep },
      fetch: (request) => mockFetch(request),
    });
    const { data } = await client.GET("/workspaces", {});
    expect(data).toEqual({ workspaces: [] });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]?.[0]).toBe(1000);
  });

  it("can be disabled", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(new Response("busy", { status: 503 }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      retry: false,
      fetch: (request) => mockFetch(request),
    });
    await client.GET("/workspaces", {});
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("typed errors", () => {
  it("parses catalog errors into PileApiError", () => {
    const response = new Response(null, {
      status: 404,
      headers: { "X-Pile-Error-Code": "NOT_FOUND" },
    });
    const error = toPileError(
      { code: "NOT_FOUND", message: "Not found", hint: "issue missing" },
      response
    );
    expect(error).toEqual({
      kind: "api",
      code: "NOT_FOUND",
      status: 404,
      message: "Not found",
      hint: "issue missing",
    });
    expect(isPileErrorCodeOf(error, "NOT_FOUND")).toBe(true);
    expect(isPileErrorCodeOf(error, "FORBIDDEN")).toBe(false);
  });

  it("falls back to http errors for legacy { error } bodies", () => {
    const error = toPileError(
      { error: "Import job not found" },
      new Response(null, { status: 404 })
    );
    expect(error).toEqual({
      kind: "http",
      status: 404,
      message: "Import job not found",
      body: { error: "Import job not found" },
    });
  });

  it("unwrap throws PileRequestError on failure", async () => {
    const mockFetch = vi.fn<FetchFn>().mockResolvedValue(
      new Response(
        JSON.stringify({ code: "UNAUTHORIZED", message: "Unauthorized" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "X-Pile-Error-Code": "UNAUTHORIZED",
          },
        }
      )
    );
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "bad",
      retry: false,
      fetch: (request) => mockFetch(request),
    });
    const promise = unwrap(client.GET("/workspaces", {}));
    await expect(promise).rejects.toBeInstanceOf(PileRequestError);
    await promise.catch((caught: unknown) => {
      if (!(caught instanceof PileRequestError)) throw caught;
      expect(caught.error).toMatchObject({
        kind: "api",
        code: "UNAUTHORIZED",
        status: 401,
      });
    });
  });

  it("unwrap returns data on success", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValue(Response.json({ workspaces: [] }));
    const client = createPileClient({
      baseUrl: "https://example.com",
      apiKey: "k",
      fetch: (request) => mockFetch(request),
    });
    await expect(unwrap(client.GET("/workspaces", {}))).resolves.toEqual({
      workspaces: [],
    });
  });
});

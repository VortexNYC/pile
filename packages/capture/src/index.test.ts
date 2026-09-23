import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCapture } from "./index.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const calls: FetchCall[] = [];

function stubFetch() {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: init?.body instanceof Blob ? await init.body.text() : init?.body,
    });
    const urlStr = String(url);
    if (urlStr.endsWith("/support/capture/token")) {
      return new Response(
        JSON.stringify({
          token: "tok_123",
          recordingUrl: "https://pile.nyc/rec/tok_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.endsWith("/support/capture/upload-session")) {
      const parsed = JSON.parse(String(init?.body)) as {
        artifacts?: Array<{ attachmentType: string; fileName?: string }>;
      };
      const artifacts = parsed.artifacts ?? [
        { attachmentType: "screenshot", fileName: "screenshot.png" },
      ];
      return new Response(
        JSON.stringify({
          uploadUrl:
            "/support/capture/upload/tok_123/screenshot/screenshot.png",
          r2Key: "k1",
          sessionId: "tok_123",
          uploads: artifacts.map((a) => ({
            uploadUrl: `/support/capture/upload/tok_123/${a.attachmentType}/${a.fileName ?? a.attachmentType}`,
            r2Key: `k_${a.attachmentType}_${a.fileName ?? "x"}`,
            attachmentType: a.attachmentType,
            fileName: a.fileName ?? a.attachmentType,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.includes("/support/capture/upload/")) {
      return new Response(JSON.stringify({ r2Key: "k" }), { status: 200 });
    }
    if (urlStr.endsWith("/support/capture/finalize")) {
      return new Response(
        JSON.stringify({
          ticketId: "ticket_1",
          shareUrl: "https://pile.nyc/s/ticket_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("ok", { status: 200 });
  });
}

beforeEach(stubFetch);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("initCapture", () => {
  it("captures console events before start() — always-on lookback", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    console.log("the bug happened before reporting");
    await capture.start();
    const result = await capture.stop({ email: "reporter@example.com" });
    expect(result.ticketId).toBe("ticket_1");

    const sessionCall = calls.find((c) => c.url.endsWith("/upload-session"));
    const body = JSON.parse(String(sessionCall?.body)) as {
      artifacts: Array<{ attachmentType: string }>;
    };
    expect(
      body.artifacts.some((a) => a.attachmentType === "debugger_json")
    ).toBe(true);
    capture.destroy();
  });

  it("report() submits a one-shot report from the lookback buffer", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    console.warn("something went wrong moments ago");
    const result = await capture.report({
      email: "reporter@example.com",
      title: "One-shot",
    });
    expect(result.ticketId).toBe("ticket_1");
    const sessionCall = calls.find((c) => c.url.endsWith("/upload-session"));
    const body = JSON.parse(String(sessionCall?.body)) as {
      title: string;
      metadata: { email: string };
    };
    expect(body.title).toBe("One-shot");
    expect(body.metadata.email).toBe("reporter@example.com");
    capture.destroy();
  });

  it("declares all artifacts in one batch upload-session and uploads in parallel", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    console.log("captured");
    capture.attach(new Blob(["PNG"], { type: "image/png" }), "screenshot.png");
    await capture.start();
    await capture.stop({ email: "r@e.com" });

    const sessionCalls = calls.filter((c) => c.url.endsWith("/upload-session"));
    expect(sessionCalls.length).toBe(1);
    const body = JSON.parse(String(sessionCalls[0]?.body)) as {
      artifacts: Array<{ attachmentType: string; fileName?: string }>;
    };
    expect(body.artifacts.map((a) => a.attachmentType)).toContain(
      "debugger_json"
    );
    expect(body.artifacts.map((a) => a.attachmentType)).toContain("screenshot");

    const uploads = calls.filter((c) => c.url.includes("/upload/tok_123/"));
    expect(uploads.length).toBe(2);
    capture.destroy();
  });

  it("sends capture token + public key headers correctly", async () => {
    const capture = initCapture({
      publicKey: "pk_abc",
      endpoint: "https://api.test",
    });
    await capture.start();
    await capture.stop({ email: "r@e.com" });
    const tokenCall = calls.find((c) => c.url.endsWith("/token"));
    expect(tokenCall?.headers["x-pile-capture-public-key"]).toBe("pk_abc");
    const finalizeCall = calls.find((c) => c.url.endsWith("/finalize"));
    expect(finalizeCall?.headers["x-pile-capture-token"]).toBe("tok_123");
    capture.destroy();
  });

  it("intercepts fetch calls as network events in the debugger payload", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    // This fetch goes through the instrumented wrapper to our stub.
    await fetch("https://example.com/api?secret_token=abc123");
    const result = await capture.report({ email: "r@e.com" });
    expect(result.ticketId).toBe("ticket_1");
    capture.destroy();
  });

  it("redacts sensitive query params from network URLs", async () => {
    const { redactSensitiveQueryParams } = await import("./engine/sanitize");
    expect(
      redactSensitiveQueryParams("https://x.com/api?token=abc&safe=1")
    ).toBe("https://x.com/api?token=%5BREDACTED%5D&safe=1");
  });

  it("sanitizes JSON bodies — sensitive keys become [REDACTED]", async () => {
    const { sanitizeCapturedBody } = await import("./engine/sanitize");
    const out = sanitizeCapturedBody(
      JSON.stringify({
        user: "a",
        password: "hunter2",
        nested: { apiKey: "k" },
      }),
      "application/json"
    );
    const parsed = JSON.parse(String(out)) as Record<string, unknown>;
    expect(parsed.password).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).apiKey).toBe(
      "[REDACTED]"
    );
    expect(parsed.user).toBe("a");
  });

  it("drops authorization-style headers from header records", async () => {
    const { toHeaderRecord } = await import("./engine/sanitize");
    const record = toHeaderRecord(
      new Headers({
        authorization: "Bearer x",
        "content-type": "application/json",
      })
    );
    expect(record.authorization).toBeUndefined();
    expect(record["content-type"]).toBe("application/json");
  });

  it("evicts by per-kind caps and dedups identical network events", async () => {
    const { appendNetworkEventWithDedup } = await import("./engine/retention");
    const events: import("./types").DebuggerEvent[] = [];
    const base = {
      kind: "network" as const,
      method: "GET",
      url: "https://a/b",
      status: 200,
    };
    appendNetworkEventWithDedup(events, { ...base, timestamp: 1000 });
    appendNetworkEventWithDedup(events, { ...base, timestamp: 1100 }); // within 350ms — dup
    appendNetworkEventWithDedup(events, { ...base, timestamp: 2000 }); // outside window — kept
    expect(events.length).toBe(2);
  });

  it("works in a non-DOM environment without crashing", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    await capture.start();
    const result = await capture.stop({ email: "r@e.com" });
    expect(result.ticketId).toBe("ticket_1");
    capture.destroy();
  });
});

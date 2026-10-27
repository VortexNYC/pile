import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCapture } from "./index.js";

// The DOM-facing media/replay layers don't exist in the test environment —
// fake a recording controller that emits MediaRecorder-style chunks and a
// replay recorder that always has events buffered.
vi.mock("./media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./media.js")>();
  return {
    ...actual,
    startDisplayRecording: vi.fn(
      async (options?: { onChunk?: (chunk: Blob, index: number) => void }) => {
        const emit = (blob: Blob, index: number) =>
          options?.onChunk?.(blob, index);
        emit(new Blob(["chunk-a"], { type: "video/webm" }), 0);
        emit(new Blob(["chunk-b"], { type: "video/webm" }), 1);
        return {
          startedAt: Date.now(),
          stream: {
            getTracks: () => [],
            getVideoTracks: () => [],
          } as unknown as MediaStream,
          stop: async () => {
            emit(new Blob(["chunk-c"], { type: "video/webm" }), 2);
            return {
              blob: new Blob(["chunk-a", "chunk-b", "chunk-c"], {
                type: "video/webm",
              }),
              durationMs: 5,
            };
          },
        };
      }
    ),
  };
});

vi.mock("./replay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./replay.js")>();
  return {
    ...actual,
    startDomRecording: vi.fn(async () => ({
      get active() {
        return true;
      },
      get degraded() {
        return false;
      },
      stop() {},
      snapshot: () => [
        { type: 4, data: { href: "https://x.test" }, timestamp: Date.now() },
      ],
    })),
  };
});

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
        multipart?: boolean;
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
          ...(parsed.multipart === true
            ? {
                uploadId: "up_1",
                partUploadUrl: "/support/capture/sessions/tok_123/upload/part",
                shareUrl: "https://pile.nyc/share/tok_123",
              }
            : {}),
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
    if (urlStr.includes("/upload/part")) {
      return new Response(
        JSON.stringify({ ok: true, partNumber: 1, etag: "etag-1" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (urlStr.includes("/support/capture/upload/")) {
      return new Response(JSON.stringify({ r2Key: "k" }), { status: 200 });
    }
    if (urlStr.endsWith("/support/capture/metadata")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

  it("streams MediaRecorder chunks as multipart parts with streamParts (PILE-665)", async () => {
    const capture = initCapture({ publicKey: "pk_test", streamParts: true });
    await capture.start({ video: true });
    const result = await capture.stop({ email: "r@e.com" });
    expect(result.ticketId).toBe("ticket_1");

    // One session for the whole flow — the recording never double-mints.
    const tokenCalls = calls.filter((c) =>
      c.url.endsWith("/support/capture/token")
    );
    expect(tokenCalls.length).toBe(1);

    // The first upload-session asked for a multipart upload.
    const sessionCalls = calls.filter((c) => c.url.endsWith("/upload-session"));
    expect(sessionCalls.length).toBe(2);
    const mintBody = JSON.parse(String(sessionCalls[0]?.body)) as {
      multipart?: boolean;
    };
    expect(mintBody.multipart).toBe(true);

    // Small chunks coalesced into a single PUT part (5 MiB part floor).
    const partCalls = calls.filter((c) => c.url.includes("/upload/part"));
    expect(partCalls.length).toBe(1);
    expect(partCalls[0]!.method).toBe("PUT");
    expect(partCalls[0]!.url).toContain("partNumber=1");
    expect(partCalls[0]!.url).toContain("uploadId=up_1");
    expect(partCalls[0]!.headers["x-pile-capture-token"]).toBe("tok_123");
    expect(String(partCalls[0]!.body)).toBe("chunk-achunk-bchunk-c");

    // No part failure → the one-shot video upload fallback stayed cold.
    const videoUploads = calls.filter((c) =>
      c.url.includes("/upload/tok_123/video/")
    );
    expect(videoUploads.length).toBe(0);

    const finalizeCalls = calls.filter((c) => c.url.endsWith("/finalize"));
    expect(finalizeCalls.length).toBe(1);
    capture.destroy();
  });

  it("attaches replay.json alongside replay.html with includeDomReplay (PILE-675)", async () => {
    const capture = initCapture({
      publicKey: "pk_test",
      includeDomReplay: true,
    });
    await capture.start();
    await capture.stop({ email: "r@e.com" });

    const sessionCall = calls.find((c) => c.url.endsWith("/upload-session"));
    const body = JSON.parse(String(sessionCall?.body)) as {
      artifacts: Array<{ attachmentType: string; fileName: string }>;
    };
    const replayFiles = body.artifacts
      .filter((a) => a.attachmentType === "replay")
      .map((a) => a.fileName);
    expect(replayFiles).toContain("replay.html");
    expect(replayFiles).toContain("replay.json");
    capture.destroy();
  });

  it("wires includeNetworkBodies into the submission metadata (PILE-675)", async () => {
    const capture = initCapture({
      publicKey: "pk_test",
      includeNetworkBodies: false,
    });
    await capture.report({ email: "r@e.com", title: "bodies off" });

    const sessionCall = calls.find((c) => c.url.endsWith("/upload-session"));
    const body = JSON.parse(String(sessionCall?.body)) as {
      metadata: { includeNetworkBodies?: boolean };
    };
    expect(body.metadata.includeNetworkBodies).toBe(false);
    capture.destroy();
  });
});

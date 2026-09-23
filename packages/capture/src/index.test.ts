import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCapture } from "./index.js";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

const calls: FetchCall[] = [];

function stubFetch() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: init?.body instanceof Blob ? await init.body.text() : init?.body,
      });
      if (url.endsWith("/support/capture/token")) {
        return new Response(
          JSON.stringify({
            token: "tok_123",
            recordingUrl: "https://pile.nyc/support/capture/sessions/tok_123",
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/support/capture/upload-session")) {
        const body = JSON.parse(String(init?.body)) as {
          attachmentType: string;
          fileName: string;
        };
        return new Response(
          JSON.stringify({
            uploadUrl: `/support/capture/upload/tok_123/${body.attachmentType}/${body.fileName}`,
            r2Key: `k/${body.fileName}`,
            sessionId: "tok_123",
          }),
          { status: 200 }
        );
      }
      if (url.includes("/support/capture/upload/")) {
        return new Response(JSON.stringify({ r2Key: "k" }), { status: 200 });
      }
      if (url.endsWith("/support/capture/finalize")) {
        return new Response(
          JSON.stringify({
            ticketId: "ticket_1",
            shareUrl: "https://pile.nyc/support/capture/public/ticket_1",
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    })
  );
}

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

describe("initCapture", () => {
  it("fetches a token with the public key and reference headers", async () => {
    const capture = initCapture({
      publicKey: "pk_test",
      reference: "order-42",
    });
    await capture.start();
    const tokenCall = calls[0];
    expect(tokenCall.url).toBe("https://pile.nyc/support/capture/token");
    expect(tokenCall.headers["x-pile-capture-public-key"]).toBe("pk_test");
    expect(tokenCall.headers["x-pile-capture-reference"]).toBe("order-42");
    expect(capture.recordingUrl).toContain("/support/capture/sessions/tok_123");
  });

  it("uses a custom endpoint when provided", async () => {
    const capture = initCapture({
      publicKey: "pk_test",
      endpoint: "https://staging.example.com/",
    });
    await capture.start();
    expect(calls[0].url).toBe(
      "https://staging.example.com/support/capture/token"
    );
  });

  it("throws when the token request fails", async () => {
    stubFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );
    const capture = initCapture({ publicKey: "bad" });
    await expect(capture.start()).rejects.toThrow("capture token failed: 401");
  });

  it("stop() throws when not started", async () => {
    const capture = initCapture({ publicKey: "pk" });
    await expect(capture.stop({ email: "a@b.c" })).rejects.toThrow(
      "capture not started"
    );
  });

  it("uploads console logs, device info, and finalizes with email metadata", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    await capture.start();
    console.log("hello from the test");
    console.error("boom");
    const result = await capture.stop({
      email: "reporter@example.com",
      title: "Checkout broken",
      priority: "high",
    });

    const sessionCalls = calls.filter((c) =>
      c.url.endsWith("/support/capture/upload-session")
    );
    const types = sessionCalls.map(
      (c) =>
        (JSON.parse(String(c.body)) as { attachmentType: string })
          .attachmentType
    );
    expect(types).toContain("log");
    expect(types).toContain("debugger_json");

    const firstBody = JSON.parse(String(sessionCalls[0].body)) as {
      title: string;
      metadata: { email: string };
    };
    expect(firstBody.title).toBe("Checkout broken");
    expect(firstBody.metadata.email).toBe("reporter@example.com");

    const uploads = calls.filter((c) =>
      c.url.includes("/support/capture/upload/")
    );
    expect(uploads.length).toBe(sessionCalls.length);
    expect(
      uploads.every((c) => c.headers["x-pile-capture-token"] === "tok_123")
    ).toBe(true);

    const finalize = calls.at(-1);
    expect(finalize?.url).toBe("https://pile.nyc/support/capture/finalize");
    expect(result.ticketId).toBe("ticket_1");
    expect(result.shareUrl).toContain("/public/ticket_1");
  });

  it("records intercepted fetch calls into the network artifact", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    await capture.start();
    await fetch("https://api.internal.test/ping", { method: "POST" });
    await capture.stop({ email: "a@b.c" });

    const networkSession = calls.find((c) => {
      if (!c.url.endsWith("/support/capture/upload-session")) return false;
      const body = JSON.parse(String(c.body)) as { attachmentType: string };
      return body.attachmentType === "network";
    });
    expect(networkSession).toBeDefined();

    const networkUpload = calls.find((c) =>
      c.url.includes("/upload/tok_123/network/")
    );
    expect(networkUpload).toBeDefined();
    const payload = String(networkUpload?.body);
    expect(payload).toContain("api.internal.test/ping");
    expect(payload).toContain('"status":200');
  });

  it("ships caller-provided screenshots and attachments", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    await capture.start();
    capture.screenshot(new Blob(["png"], { type: "image/png" }));
    capture.attach(new Blob(["notes"]), "notes.txt", "debugger_json");
    await capture.stop({
      email: "a@b.c",
      screenshot: new Blob(["shot"], { type: "image/png" }),
    });
    const uploads = calls.filter((c) =>
      c.url.includes("/support/capture/upload/")
    );
    const names = uploads.map((c) => c.url.split("/").pop());
    expect(names).toContain("screenshot.png");
    expect(names).toContain("notes.txt");
    expect(uploads.filter((c) => c.url.endsWith("screenshot.png")).length).toBe(
      2
    );
  });

  it("instruments nothing in a non-DOM environment without crashing", async () => {
    const capture = initCapture({ publicKey: "pk_test" });
    await capture.start();
    const result = await capture.stop({ email: "a@b.c" });
    expect(result.ticketId).toBe("ticket_1");
    // still ships the debugger_json artifact
    const types = calls
      .filter((c) => c.url.endsWith("/support/capture/upload-session"))
      .map(
        (c) =>
          (JSON.parse(String(c.body)) as { attachmentType: string })
            .attachmentType
      );
    expect(types).toEqual(["debugger_json"]);
  });
});

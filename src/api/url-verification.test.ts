import { describe, expect, it } from "vitest";

import { verifyExternalUrl } from "./url-verification.js";

async function withProbe<T>(
  probe: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    probe(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
      init
    );
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const chunk = (s: string) => new TextEncoder().encode(s);

describe("verifyExternalUrl (PILE-429)", () => {
  it("returns unchecked for non-http(s) URLs without probing", async () => {
    let probed = false;
    const result = await withProbe(
      async () => {
        probed = true;
        return new Response("ok");
      },
      () => verifyExternalUrl("ftp://files.example.com/doc")
    );
    expect(probed).toBe(false);
    expect(result.status).toBe("unchecked");
    expect(result.verifiedAt).toBeNull();
  });

  it("marks 2xx targets verified and extracts the HTML title", async () => {
    const result = await withProbe(
      async () =>
        new Response(
          "<html><head><title>Spec &amp; Design</title></head><body>…</body></html>",
          { status: 200, headers: { "content-type": "text/html" } }
        ),
      () => verifyExternalUrl("https://docs.example.com/spec")
    );
    expect(result.status).toBe("verified");
    expect(result.httpStatus).toBe(200);
    expect(result.resolvedTitle).toBe("Spec & Design");
    expect(result.resolvedUrl).toBe("https://docs.example.com/spec");
    expect(result.verifiedAt).not.toBeNull();
  });

  it("assembles a title split across response chunks", async () => {
    const result = await withProbe(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk("<html><head><tit"));
              controller.enqueue(chunk("le>Split T"));
              controller.enqueue(chunk("itle</title></head>"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } }
        ),
      () => verifyExternalUrl("https://docs.example.com/split")
    );
    expect(result.resolvedTitle).toBe("Split Title");
  });

  it("marks reachable-but-erroring targets failed with the http status", async () => {
    const result = await withProbe(
      async () => new Response("nope", { status: 404 }),
      () => verifyExternalUrl("https://docs.example.com/missing")
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(404);
    expect(result.resolvedTitle).toBeNull();
  });

  it("marks network errors and timeouts unreachable", async () => {
    const result = await withProbe(
      async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
      () => verifyExternalUrl("https://dead.example.com/")
    );
    expect(result.status).toBe("unreachable");
    expect(result.httpStatus).toBeNull();
    expect(result.resolvedUrl).toBeNull();
    expect(result.verifiedAt).not.toBeNull();
  });

  it("skips title extraction for non-HTML bodies", async () => {
    const result = await withProbe(
      async () =>
        new Response("PDF-bytes", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      () => verifyExternalUrl("https://files.example.com/a.pdf")
    );
    expect(result.status).toBe("verified");
    expect(result.resolvedTitle).toBeNull();
  });

  it("sends the verifier user agent so hosts don't 403 the probe", async () => {
    let ua: string | null = null;
    await withProbe(
      async (_url, init) => {
        ua =
          init?.headers && typeof init.headers === "object"
            ? (new Headers(init.headers).get("user-agent") ?? null)
            : null;
        return new Response("ok", { status: 200 });
      },
      () => verifyExternalUrl("https://docs.example.com/")
    );
    expect(ua).toContain("Pile-LinkVerifier");
  });
});

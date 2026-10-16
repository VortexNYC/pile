import type { ExternalLinkVerification } from "../workspace/data/index.js";

// Best-effort reachability probe for external-link URLs (PILE-429).
// A syntactically valid URL is not enough — agents need to know whether
// the link actually resolves. Runs inline on create/update with a
// bounded timeout so a dead host can't stall the request, and records
// the outcome on the row rather than rejecting the write (a link to an
// intranet page the worker can't reach is still a valid link).
const PROBE_TIMEOUT_MS = 5000;
const TITLE_SCAN_BYTES = 64 * 1024;
const TITLE_MAX_CHARS = 512;
// Custom UA — some hosts (including pile.nyc, PILE-415) 403 the
// default Cloudflare Workers fetch agent.
const VERIFIER_UA = "Pile-LinkVerifier/1.0 (+https://pile.nyc)";

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function unchecked(): ExternalLinkVerification {
  return {
    status: "unchecked",
    verifiedAt: null,
    resolvedUrl: null,
    resolvedTitle: null,
    httpStatus: null,
  };
}

function codePoint(value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      codePoint(Number.parseInt(h, 16))
    )
    .replace(
      /&([a-z]+);/gi,
      (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m
    );
}

// Reads until the closing </title> or the scan cap, whichever comes
// first, then cancels — link targets can be arbitrarily large.
async function readHtmlTitle(
  body: ReadableStream<Uint8Array>
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let rawTitle: string | null = null;
  try {
    let received = 0;
    while (received < TITLE_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      buffered += decoder.decode(value, { stream: true });
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buffered);
      if (match) {
        rawTitle = match[1] ?? null;
        break;
      }
    }
  } catch {
    // A truncated stream is still useful — fall through with whatever
    // title we managed to buffer.
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (rawTitle === null) return null;
  const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
  return title === "" ? null : title.slice(0, TITLE_MAX_CHARS);
}

export async function verifyExternalUrl(
  rawUrl: string
): Promise<ExternalLinkVerification> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return unchecked();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return unchecked();
  }
  try {
    const res = await fetch(url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        "user-agent": VERIFIER_UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
    let title: string | null = null;
    if (res.body !== null) {
      const contentType = res.headers.get("content-type") ?? "";
      if (res.status < 400 && contentType.includes("text/html")) {
        title = await readHtmlTitle(res.body);
      } else {
        await res.body.cancel().catch(() => {});
      }
    }
    return {
      status: res.status < 400 ? "verified" : "failed",
      verifiedAt: new Date().toISOString(),
      resolvedUrl: res.url === "" ? url.toString() : res.url,
      resolvedTitle: title,
      httpStatus: res.status,
    };
  } catch {
    // DNS failure, connect reset, timeout — the host can't be reached
    // from this worker right now.
    return {
      status: "unreachable",
      verifiedAt: new Date().toISOString(),
      resolvedUrl: null,
      resolvedTitle: null,
      httpStatus: null,
    };
  }
}

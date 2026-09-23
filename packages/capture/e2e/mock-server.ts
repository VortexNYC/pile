import { readFile } from "node:fs/promises";
/**
 * In-process mock of the Pile `/support/capture/*` protocol plus a static
 * server for the e2e test page and SDK bundle. Records every uploaded
 * artifact so the spec can assert what a real browser captured.
 */
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

export interface ReceivedArtifact {
  attachmentType: string;
  fileName: string;
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
  /** Decompressed UTF-8 text when content-encoding was gzip. */
  text(): string;
}

export interface MockServer {
  url: string;
  artifacts: ReceivedArtifact[];
  finalized: boolean;
  close: () => Promise<void>;
}

const PAGE_HTML = `<!doctype html>
<html>
<head><title>e2e capture page</title></head>
<body>
  <button id="target-btn">click me</button>
  <input id="secret-input" type="password" value="" />
  <script src="/capture.js"></script>
  <script>
    window.capture = PileCapture.initCapture({
      publicKey: "pk_e2e",
      endpoint: location.origin,
      replay: true,
    });
    console.log("e2e repro log");
    console.error("e2e repro error");
    fetch("/api/data", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sekret" },
      body: JSON.stringify({ password: "hunter2", ok: true }),
    });
    window.doReport = () =>
      window.capture.report({ email: "e2e@pile.dev", title: "E2E report" });
  </script>
</body>
</html>`;

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

export async function startMockServer(bundlePath: string): Promise<MockServer> {
  const artifacts: ReceivedArtifact[] = [];
  let finalized = false;
  const bundle = await readFile(bundlePath);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("content-type", "text/html").end(PAGE_HTML);
      return;
    }
    if (url.pathname === "/capture.js") {
      res.setHeader("content-type", "text/javascript").end(bundle);
      return;
    }
    if (url.pathname === "/api/data") {
      res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/support/capture/token" && req.method === "POST") {
      res.setHeader("content-type", "application/json").end(
        JSON.stringify({
          token: "session-e2e",
          recordingUrl: "http://localhost/support/capture/sessions/session-e2e",
        })
      );
      return;
    }
    if (
      url.pathname === "/support/capture/upload-session" &&
      req.method === "POST"
    ) {
      const body = JSON.parse((await readBody(req)).toString()) as {
        artifacts: { attachmentType: string; fileName: string }[];
      };
      const uploads = body.artifacts.map((a) => ({
        attachmentType: a.attachmentType,
        fileName: a.fileName,
        uploadUrl: `/support/capture/upload/session-e2e/${a.attachmentType}/${a.fileName}`,
        r2Key: `e2e/${a.fileName}`,
      }));
      res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify({ uploads }));
      return;
    }
    if (
      url.pathname.startsWith("/support/capture/upload/") &&
      req.method === "POST"
    ) {
      const parts = url.pathname.split("/");
      const body = await readBody(req);
      const contentEncoding = req.headers["content-encoding"] as
        | string
        | undefined;
      const decoded = contentEncoding === "gzip" ? gunzipSync(body) : body;
      artifacts.push({
        attachmentType: parts[5],
        fileName: decodeURIComponent(parts[6] ?? ""),
        contentType: (req.headers["content-type"] as string) ?? "",
        contentEncoding,
        body,
        text: () => decoded.toString("utf-8"),
      });
      res.setHeader("content-type", "application/json").end("{}");
      return;
    }
    if (url.pathname === "/support/capture/finalize" && req.method === "POST") {
      finalized = true;
      res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify({ ticketId: "ticket-e2e", shareUrl: null }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    artifacts,
    get finalized() {
      return finalized;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

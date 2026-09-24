import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "vite";

import { startMockServer } from "./mock-server";

interface ReportResult {
  ticketId: string;
  recordingUrl: string;
}

interface DebuggerPayload {
  logs?: { level: string; message: string }[];
  networkRequests?: {
    method: string;
    url: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    requestBody?: string;
    responseBody?: string;
    timing?: { ttfb?: number; download?: number };
    graphql?: {
      operationName?: string;
      operationType?: string;
      hasErrors?: boolean;
    };
  }[];
  actions?: {
    type: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }[];
}

test.describe.configure({ mode: "serial" });

test("real browser captures console, network, actions, and DOM replay", async ({
  page,
}) => {
  const bundleDir = join(import.meta.dirname, ".bundle");
  await build({
    configFile: false,
    root: join(import.meta.dirname, ".."),
    logLevel: "silent",
    build: {
      emptyOutDir: true,
      lib: {
        entry: "src/index.ts",
        name: "PileCapture",
        formats: ["iife"],
        fileName: () => "capture.js",
      },
      outDir: "e2e/.bundle",
      minify: false,
    },
  });
  const server = await startMockServer(join(bundleDir, "capture.js"));
  try {
    const dataResponse = page.waitForResponse((r) =>
      r.url().includes("/api/data")
    );
    const gqlResponse = page.waitForResponse((r) =>
      r.url().includes("/api/graphql")
    );
    await page.goto(server.url);
    await page.waitForFunction(() => typeof window.capture === "object");
    // Let the initial fetch + rrweb full snapshot land.
    await dataResponse;
    await gqlResponse;

    await page.click("#target-btn");
    await page.fill("#secret-input", "hunter2");

    // Headless environments can't getDisplayMedia — the harness provides the
    // pixels instead (Playwright page.screenshot → attach). This is the
    // contract for agents running without a display surface.
    const png = await page.screenshot({ type: "png" });
    await page.evaluate((bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      (
        window as unknown as {
          capture: { attach: (b: Blob, name: string) => void };
        }
      ).capture.attach(blob, "harness-screenshot.png");
    }, Array.from(png));

    const result = (await page.evaluate(() =>
      (
        window as unknown as { doReport: () => Promise<ReportResult> }
      ).doReport()
    )) as ReportResult;
    expect(result.ticketId).toBe("ticket-e2e");
    expect(server.finalized).toBe(true);

    // Debugger payload — gzipped end-to-end, then asserted on contents.
    const debuggerArtifact = server.artifacts.find(
      (a) => a.attachmentType === "debugger_json"
    );
    expect(debuggerArtifact).toBeDefined();
    expect(debuggerArtifact?.fileName).toBe("debugger.json.gz");
    expect(debuggerArtifact?.contentEncoding).toBe("gzip");
    const payload = JSON.parse(
      debuggerArtifact?.text() ?? "{}"
    ) as DebuggerPayload;

    // Console captured (the "bug happened before report" model).
    expect(
      payload.logs?.some(
        (e) => e.level === "log" && e.message.includes("e2e repro log")
      )
    ).toBe(true);
    expect(payload.logs?.some((e) => e.level === "error")).toBe(true);

    // Network captured with sanitization: authorization header dropped,
    // password field redacted, response body present.
    const dataReq = payload.networkRequests?.find((r) =>
      r.url.includes("/api/data")
    );
    expect(dataReq).toBeDefined();
    expect(dataReq?.method).toBe("POST");
    expect(dataReq?.status).toBe(200);
    expect(dataReq?.requestHeaders?.authorization).toBeUndefined();
    expect(dataReq?.requestBody).toContain("[REDACTED]");
    expect(dataReq?.requestBody).not.toContain("hunter2");
    expect(dataReq?.responseBody).toContain('"ok":true');

    // DevTools-grade timing phases captured via PerformanceResourceTiming.
    expect(dataReq?.timing?.ttfb).toBeGreaterThanOrEqual(0);
    expect(dataReq?.timing?.download).toBeGreaterThanOrEqual(0);

    // GraphQL: operation name/type extracted, errors-in-200 flagged.
    const gqlReq = payload.networkRequests?.find((r) =>
      r.url.includes("/api/graphql")
    );
    expect(gqlReq?.graphql?.operationName).toBe("GetUser");
    expect(gqlReq?.graphql?.operationType).toBe("query");
    expect(gqlReq?.graphql?.hasErrors).toBe(true);

    // jam.metadata() parity: live callback values landed in report metadata.
    const submittedMetadata = server.sessionBody?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(submittedMetadata?.plan).toBe("enterprise");
    expect(submittedMetadata?.userId).toBe(42);

    // Click action captured; input action must never carry the value.
    expect(
      payload.actions?.some(
        (a) => a.type === "click" && a.target?.includes("target-btn")
      )
    ).toBe(true);
    const inputAction = payload.actions?.find((a) => a.type === "input");
    expect(inputAction).toBeDefined();
    expect(inputAction?.metadata?.value).toBeUndefined();

    // Harness-provided screenshot uploaded as a first-class artifact.
    const shot = server.artifacts.find(
      (a) => a.attachmentType === "screenshot"
    );
    expect(shot).toBeDefined();
    expect(shot?.fileName).toBe("harness-screenshot.png");
    expect(shot?.contentType).toBe("image/png");
    expect(shot?.body.length).toBeGreaterThan(100);
    expect(shot?.body.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );

    // DOM replay artifact: self-contained HTML with rrweb events embedded.
    const replay = server.artifacts.find((a) => a.attachmentType === "replay");
    expect(replay).toBeDefined();
    expect(replay?.fileName).toBe("replay.html");
    const replayHtml = replay?.text() ?? "";
    expect(replayHtml).toContain("rrweb.Replayer");
    expect(replayHtml).toContain('"type":2');
    // Masked input: the typed password must not appear in the replay events.
    expect(replayHtml).not.toContain("hunter2");
    // Auto-blur: data-pile-blur blocked, industry .fs-mask masked — the
    // sensitive text must not appear in the replay event stream.
    expect(replayHtml).not.toContain("PILE_BLUR_SECRET");
    expect(replayHtml).not.toContain("FS_MASK_SECRET");
  } finally {
    await server.close();
  }
});

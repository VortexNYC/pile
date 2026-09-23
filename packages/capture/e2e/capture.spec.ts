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
    configFile: join(import.meta.dirname, "vite.config.ts"),
    logLevel: "silent",
  });
  const server = await startMockServer(join(bundleDir, "capture.js"));
  try {
    const dataResponse = page.waitForResponse((r) =>
      r.url().includes("/api/data")
    );
    await page.goto(server.url);
    await page.waitForFunction(() => typeof window.capture === "object");
    // Let the initial fetch + rrweb full snapshot land.
    await dataResponse;

    await page.click("#target-btn");
    await page.fill("#secret-input", "hunter2");

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

    // Click action captured; input action must never carry the value.
    expect(
      payload.actions?.some(
        (a) => a.type === "click" && a.target?.includes("target-btn")
      )
    ).toBe(true);
    const inputAction = payload.actions?.find((a) => a.type === "input");
    expect(inputAction).toBeDefined();
    expect(inputAction?.metadata?.value).toBeUndefined();

    // DOM replay artifact: self-contained HTML with rrweb events embedded.
    const replay = server.artifacts.find((a) => a.attachmentType === "replay");
    expect(replay).toBeDefined();
    expect(replay?.fileName).toBe("replay.html");
    const replayHtml = replay?.text() ?? "";
    expect(replayHtml).toContain("rrweb.Replayer");
    expect(replayHtml).toContain('"type":2');
    // Masked input: the typed password must not appear in the replay events.
    expect(replayHtml).not.toContain("hunter2");
  } finally {
    await server.close();
  }
});

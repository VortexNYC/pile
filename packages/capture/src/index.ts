/**
 * Pile support-capture SDK.
 *
 * Records what Jam-style tools record — console output, errors, network
 * activity, user breadcrumbs, device metadata, an optional screenshot, and
 * optional screen video — then ships it to a Pile workspace through the
 * public `/support/capture/*` protocol.
 *
 * Usage:
 *   const capture = initCapture({ publicKey: "pk_…" });
 *   await capture.start();
 *   // … user reproduces the bug …
 *   const { ticketId, shareUrl } = await capture.stop({ email, title });
 */

const DEFAULT_ENDPOINT = "https://pile.nyc";
const DEFAULT_MAX_ENTRIES = 500;
const BODY_CAPTURE_LIMIT = 4096;

export type CaptureAttachmentType =
  | "screenshot"
  | "video"
  | "debugger_json"
  | "log"
  | "network";

export interface CaptureOptions {
  /** Capture public key issued by the target workspace. */
  publicKey: string;
  /** API origin. Defaults to https://pile.nyc. */
  endpoint?: string;
  /** Optional caller-side reference echoed back on the session. */
  reference?: string;
  /** Record screen video via getDisplayMedia + MediaRecorder. */
  video?: boolean;
  /** Include request/response bodies (truncated) in the network log. */
  networkBodies?: boolean;
  /** Ring-buffer size for console/network/breadcrumb entries. */
  maxEntries?: number;
}

export interface StopOptions {
  /** Reporter email — required by the server to file the ticket. */
  email: string;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  tags?: string[];
  url?: string;
  visibility?: "public" | "private";
  /** Screenshot blob attached with the report. */
  screenshot?: Blob;
  /** Extra metadata merged into the capture session. */
  metadata?: Record<string, unknown>;
}

export interface CaptureResult {
  ticketId: string;
  shareUrl?: string;
  recordingUrl: string;
}

interface PendingAttachment {
  attachmentType: CaptureAttachmentType;
  fileName: string;
  blob: Blob;
}

interface CaptureState {
  token: string;
  recordingUrl: string;
  logs: string[];
  network: string[];
  attachments: PendingAttachment[];
  videoRecorder?: MediaRecorder;
  videoStream?: MediaStream;
  videoChunks: Blob[];
  restore: Array<() => void>;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function pushCapped<T>(buffer: T[], item: T, cap: number): void {
  buffer.push(item);
  if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
}

function safeJsonLine(fields: Record<string, unknown>): string {
  return serialize(fields);
}

function instrumentConsole(state: CaptureState, cap: number): () => void {
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const originals = levels.map((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushCapped(
        state.logs,
        safeJsonLine({
          kind: "console",
          level,
          ts: Date.now(),
          args: args.map(serialize),
        }),
        cap
      );
      original(...args);
    };
    return { level, original };
  });
  return () => {
    for (const { level, original } of originals) console[level] = original;
  };
}

function instrumentErrors(state: CaptureState, cap: number): () => void {
  if (typeof window === "undefined") return () => {};
  const onError = (event: ErrorEvent) => {
    pushCapped(
      state.logs,
      safeJsonLine({
        kind: "error",
        ts: Date.now(),
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      }),
      cap
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    pushCapped(
      state.logs,
      safeJsonLine({
        kind: "unhandledrejection",
        ts: Date.now(),
        reason: serialize(event.reason),
      }),
      cap
    );
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

function instrumentClicks(state: CaptureState, cap: number): () => void {
  if (typeof document === "undefined") return () => {};
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    pushCapped(
      state.logs,
      safeJsonLine({
        kind: "breadcrumb",
        ts: Date.now(),
        action: "click",
        target: target
          ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`
          : undefined,
      }),
      cap
    );
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

function instrumentFetch(
  state: CaptureState,
  cap: number,
  captureBodies: boolean
): () => void {
  if (typeof fetch !== "function") return () => {};
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = Date.now();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method =
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET");
    try {
      const response = await original(input, init);
      const entry: Record<string, unknown> = {
        kind: "fetch",
        ts: started,
        method,
        url,
        status: response.status,
        durationMs: Date.now() - started,
      };
      if (captureBodies && init?.body) {
        entry.requestBody = serialize(init.body).slice(0, BODY_CAPTURE_LIMIT);
      }
      pushCapped(state.network, safeJsonLine(entry), cap);
      return response;
    } catch (error) {
      pushCapped(
        state.network,
        safeJsonLine({
          kind: "fetch",
          ts: started,
          method,
          url,
          error: serialize(error),
          durationMs: Date.now() - started,
        }),
        cap
      );
      throw error;
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}

function instrumentXhr(state: CaptureState, cap: number): () => void {
  if (typeof XMLHttpRequest === "undefined") return () => {};
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (
    this: XMLHttpRequest & {
      pileXhrMeta?: { method: string; url: string; ts: number };
    },
    method: string,
    url: string | URL,
    async = true,
    user?: string | null,
    password?: string | null
  ) {
    this.pileXhrMeta = { method, url: String(url), ts: 0 };
    Reflect.apply(originalOpen, this, [
      method,
      String(url),
      async,
      user ?? null,
      password ?? null,
    ]);
  };
  proto.send = function (
    this: XMLHttpRequest & {
      pileXhrMeta?: { method: string; url: string; ts: number };
    },
    ...args: unknown[]
  ) {
    const meta = this.pileXhrMeta;
    if (meta) {
      meta.ts = Date.now();
      this.addEventListener("loadend", () => {
        pushCapped(
          state.network,
          safeJsonLine({
            kind: "xhr",
            ts: meta.ts,
            method: meta.method,
            url: meta.url,
            status: this.status,
            durationMs: Date.now() - meta.ts,
          }),
          cap
        );
      });
    }
    return originalSend.apply(this, args as []);
  };
  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
  };
}

function collectDeviceInfo(): Record<string, unknown> {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return {};
  }
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: {
      width: window.screen?.width,
      height: window.screen?.height,
      pixelRatio: window.devicePixelRatio,
    },
    url: window.location?.href,
    referrer: document?.referrer,
    timestamp: new Date().toISOString(),
  };
}

async function startScreenVideo(state: CaptureState): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    return;
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const recorder = new MediaRecorder(stream);
  state.videoStream = stream;
  state.videoRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.videoChunks.push(event.data);
  };
  recorder.start(1000);
}

async function finishScreenVideo(state: CaptureState): Promise<Blob | null> {
  const recorder = state.videoRecorder;
  const stream = state.videoStream;
  if (!recorder || !stream) return null;
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.stop();
  await done;
  for (const track of stream.getTracks()) track.stop();
  if (state.videoChunks.length === 0) return null;
  return new Blob(state.videoChunks, {
    type: recorder.mimeType || "video/webm",
  });
}

export interface CaptureSession {
  start(): Promise<void>;
  stop(options: StopOptions): Promise<CaptureResult>;
  /** Queue an extra artifact to ship with the report. */
  attach(
    blob: Blob,
    fileName: string,
    attachmentType?: CaptureAttachmentType
  ): void;
  /** Queue a screenshot blob. */
  screenshot(blob: Blob): void;
  /** Public playback URL for this capture session, once started. */
  readonly recordingUrl: string | undefined;
}

export function initCapture(options: CaptureOptions): CaptureSession {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/u, "");
  const cap = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let state: CaptureState | undefined;

  const api = {
    get recordingUrl() {
      return state?.recordingUrl;
    },

    attach(
      blob: Blob,
      fileName: string,
      attachmentType: CaptureAttachmentType = "debugger_json"
    ) {
      state?.attachments.push({ attachmentType, fileName, blob });
    },

    screenshot(blob: Blob) {
      api.attach(blob, "screenshot.png", "screenshot");
    },

    async start() {
      if (state) return;
      const tokenRes = await fetch(`${endpoint}/support/capture/token`, {
        method: "POST",
        headers: {
          "x-pile-capture-public-key": options.publicKey,
          ...(options.reference
            ? { "x-pile-capture-reference": options.reference }
            : {}),
        },
      });
      if (!tokenRes.ok) {
        throw new Error(`capture token failed: ${tokenRes.status}`);
      }
      const { token, recordingUrl } = (await tokenRes.json()) as {
        token: string;
        recordingUrl: string;
      };
      const next: CaptureState = {
        token,
        recordingUrl,
        logs: [],
        network: [],
        attachments: [],
        videoChunks: [],
        restore: [],
      };
      next.restore.push(instrumentConsole(next, cap));
      next.restore.push(instrumentErrors(next, cap));
      next.restore.push(instrumentClicks(next, cap));
      next.restore.push(
        instrumentFetch(next, cap, options.networkBodies === true)
      );
      next.restore.push(instrumentXhr(next, cap));
      state = next;
      if (options.video) {
        await startScreenVideo(next);
      }
    },

    async stop(stopOptions: StopOptions): Promise<CaptureResult> {
      if (!state) throw new Error("capture not started");
      const current = state;
      state = undefined;
      for (const restore of current.restore) restore();

      const videoBlob = await finishScreenVideo(current);
      if (videoBlob) {
        current.attachments.push({
          attachmentType: "video",
          fileName: "recording.webm",
          blob: videoBlob,
        });
      }

      if (stopOptions.screenshot) {
        current.attachments.push({
          attachmentType: "screenshot",
          fileName: "screenshot.png",
          blob: stopOptions.screenshot,
        });
      }
      if (current.logs.length > 0) {
        current.attachments.push({
          attachmentType: "log",
          fileName: "console.jsonl",
          blob: new Blob([current.logs.join("\n")], {
            type: "application/x-ndjson",
          }),
        });
      }
      if (current.network.length > 0) {
        current.attachments.push({
          attachmentType: "network",
          fileName: "network.jsonl",
          blob: new Blob([current.network.join("\n")], {
            type: "application/x-ndjson",
          }),
        });
      }
      current.attachments.push({
        attachmentType: "debugger_json",
        fileName: "debugger.json",
        blob: new Blob([serialize(collectDeviceInfo())], {
          type: "application/json",
        }),
      });

      const baseMetadata: Record<string, unknown> = {
        email: stopOptions.email,
        title: stopOptions.title,
        description: stopOptions.description,
        priority: stopOptions.priority,
        tags: stopOptions.tags,
        url: stopOptions.url,
        visibility: stopOptions.visibility,
        ...stopOptions.metadata,
      };
      const metadata = Object.fromEntries(
        Object.entries(baseMetadata).filter(([, v]) => v !== undefined)
      );

      // Sequential on purpose: upload-session read-modify-writes the
      // session's uploads list in D1, so parallel calls would drop entries.
      const headers = { "x-pile-capture-token": current.token };
      for (const attachment of current.attachments) {
        const sessionRes = await fetch(
          `${endpoint}/support/capture/upload-session`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: serialize({
              title: stopOptions.title ?? "Bug report",
              attachmentType: attachment.attachmentType,
              fileName: attachment.fileName,
              contentType: attachment.blob.type || undefined,
              metadata,
              deviceInfo: collectDeviceInfo(),
            }),
          }
        );
        if (!sessionRes.ok) {
          throw new Error(`upload-session failed: ${sessionRes.status}`);
        }
        const { uploadUrl } = (await sessionRes.json()) as {
          uploadUrl: string;
        };
        const uploadRes = await fetch(`${endpoint}${uploadUrl}`, {
          method: "POST",
          headers: { ...headers, "content-type": attachment.blob.type },
          body: attachment.blob,
        });
        if (!uploadRes.ok) {
          throw new Error(`artifact upload failed: ${uploadRes.status}`);
        }
      }

      const finalizeRes = await fetch(`${endpoint}/support/capture/finalize`, {
        method: "POST",
        headers,
      });
      if (!finalizeRes.ok) {
        throw new Error(`finalize failed: ${finalizeRes.status}`);
      }
      const finalized = (await finalizeRes.json()) as {
        ticketId: string;
        shareUrl?: string;
      };
      return { ...finalized, recordingUrl: current.recordingUrl };
    },
  };

  return api;
}

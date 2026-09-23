import { MAX_REPORT_MEDIA_BYTES } from "./constants.js";
import type { CaptureArtifact, CaptureStopOptions } from "./types.js";

const ABSOLUTE_HTTP_URL_REGEX = /^https?:\/\//;
const FILE_SIZE_LIMIT_MESSAGE =
  "This artifact is too large to upload reliably. Retry with a shorter recording or a screenshot.";

export interface TransportConfig {
  endpoint: string;
  publicKey: string;
  reference?: string;
}

export interface TransportReport {
  title: string;
  description?: string;
  priority?: CaptureStopOptions["priority"];
  tags?: string[];
  url?: string;
  visibility?: CaptureStopOptions["visibility"];
  email: string;
  fullName?: string;
  metadata: Record<string, unknown>;
  deviceInfo: Record<string, unknown>;
  artifacts: CaptureArtifact[];
}

export interface TransportResult {
  ticketId: string;
  shareUrl?: string;
  recordingUrl: string;
}

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      size?: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
}

function getTurnstile(): TurnstileGlobal | undefined {
  const w = globalThis as { turnstile?: TurnstileGlobal };
  return w.turnstile;
}

async function loadTurnstileScript(): Promise<TurnstileGlobal | undefined> {
  if (typeof document === "undefined") {
    return undefined;
  }
  const existing = getTurnstile();
  if (existing) {
    return existing;
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => resolve(getTurnstile()));
    script.addEventListener("error", () => resolve(undefined));
    document.head.appendChild(script);
  });
}

function runTurnstileChallenge(siteKey: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    void (async () => {
      const turnstile = await loadTurnstileScript();
      if (!turnstile || typeof document === "undefined") {
        resolve(undefined);
        return;
      }
      const container = document.createElement("div");
      container.style.display = "none";
      document.body.appendChild(container);
      const widgetId = turnstile.render(container, {
        sitekey: siteKey,
        size: "invisible",
        callback: (token) => {
          turnstile.remove(widgetId);
          container.remove();
          resolve(token);
        },
        "error-callback": () => {
          turnstile.remove(widgetId);
          container.remove();
          resolve(undefined);
        },
      });
    })();
  });
}

async function postToken(
  config: TransportConfig,
  turnstileToken?: string
): Promise<Response> {
  return fetch(`${config.endpoint}/support/capture/token`, {
    method: "POST",
    headers: {
      "x-pile-capture-public-key": config.publicKey,
      ...(config.reference
        ? { "x-pile-capture-reference": config.reference }
        : {}),
      ...(turnstileToken ? { "content-type": "application/json" } : {}),
    },
    credentials: "omit",
    mode: "cors",
    ...(turnstileToken ? { body: JSON.stringify({ turnstileToken }) } : {}),
  });
}

async function fetchCaptureToken(
  config: TransportConfig
): Promise<{ token: string; recordingUrl: string }> {
  let response = await postToken(config);
  if (response.status === 403) {
    const errorBody = (await response.json().catch(() => null)) as {
      code?: string;
      details?: { siteKey?: string };
    } | null;
    const siteKey = errorBody?.details?.siteKey;
    if (errorBody?.code === "CAPTURE_CHALLENGE_REQUIRED" && siteKey) {
      const challengeToken = await runTurnstileChallenge(siteKey);
      if (challengeToken) {
        response = await postToken(config, challengeToken);
      }
    }
  }
  if (!response.ok) {
    throw new Error(`capture token failed: ${response.status}`);
  }
  return (await response.json()) as { token: string; recordingUrl: string };
}

interface DeclaredUpload {
  uploadUrl: string;
  r2Key: string;
  attachmentType: string;
  fileName: string;
}

export async function submitCaptureReport(
  config: TransportConfig,
  report: TransportReport
): Promise<TransportResult> {
  for (const artifact of report.artifacts) {
    if (artifact.blob.size > MAX_REPORT_MEDIA_BYTES) {
      throw new Error(FILE_SIZE_LIMIT_MESSAGE);
    }
  }

  const { token, recordingUrl } = await fetchCaptureToken(config);
  const headers = { "x-pile-capture-token": token };

  // One batch declaration → one session-metadata write → parallel uploads.
  const sessionResponse = await fetch(
    `${config.endpoint}/support/capture/upload-session`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      credentials: "omit",
      mode: "cors",
      body: JSON.stringify({
        title: report.title,
        description: report.description,
        priority: report.priority,
        tags: report.tags,
        url: report.url,
        visibility: report.visibility,
        metadata: report.metadata,
        deviceInfo: report.deviceInfo,
        artifacts: report.artifacts.map((artifact) => ({
          attachmentType: artifact.attachmentType,
          fileName: artifact.fileName,
          contentType: artifact.blob.type || undefined,
        })),
      }),
    }
  );
  if (!sessionResponse.ok) {
    throw new Error(`upload-session failed: ${sessionResponse.status}`);
  }
  const sessionPayload = (await sessionResponse.json()) as {
    uploads?: DeclaredUpload[];
  };
  const declaredUploads = sessionPayload.uploads ?? [];

  await Promise.all(
    report.artifacts.map(async (artifact, index) => {
      const target = declaredUploads[index];
      if (!target) {
        throw new Error("upload-session did not declare all artifacts");
      }
      const uploadUrl = ABSOLUTE_HTTP_URL_REGEX.test(target.uploadUrl)
        ? target.uploadUrl
        : `${config.endpoint}${target.uploadUrl}`;
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": artifact.blob.type || "application/octet-stream",
          ...(artifact.contentEncoding
            ? { "content-encoding": artifact.contentEncoding }
            : {}),
        },
        credentials: "omit",
        mode: "cors",
        body: artifact.blob,
      });
      if (!uploadResponse.ok) {
        throw new Error(`artifact upload failed: ${uploadResponse.status}`);
      }
    })
  );

  const finalizeResponse = await fetch(
    `${config.endpoint}/support/capture/finalize`,
    { method: "POST", headers, credentials: "omit", mode: "cors" }
  );
  if (!finalizeResponse.ok) {
    throw new Error(`finalize failed: ${finalizeResponse.status}`);
  }
  const finalized = (await finalizeResponse.json()) as {
    ticketId: string;
    shareUrl?: string;
  };
  return {
    ticketId: finalized.ticketId,
    shareUrl: finalized.shareUrl,
    recordingUrl,
  };
}

export async function gzipBlob(blob: Blob): Promise<Blob> {
  if (typeof CompressionStream !== "function") {
    return blob;
  }
  const compressedStream = blob
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(compressedStream).blob();
}

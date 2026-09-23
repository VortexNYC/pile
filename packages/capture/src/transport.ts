import type { CaptureArtifact, CaptureStopOptions } from "./types";

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

async function fetchCaptureToken(
  config: TransportConfig
): Promise<{ token: string; recordingUrl: string }> {
  const response = await fetch(`${config.endpoint}/support/capture/token`, {
    method: "POST",
    headers: {
      "x-pile-capture-public-key": config.publicKey,
      ...(config.reference
        ? { "x-pile-capture-reference": config.reference }
        : {}),
    },
    credentials: "omit",
    mode: "cors",
  });
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
  const maxBytes = 95 * 1024 * 1024;
  for (const artifact of report.artifacts) {
    if (artifact.blob.size > maxBytes) {
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

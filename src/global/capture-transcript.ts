// PILE-664 — Cap-style transcripts for capture recordings.
//
// A screen recording's audio is opaque to agents, triage, and memory recall.
// After a capture lands (finalize, member feedback, or a Jam webhook), this
// module pulls the recording back out of R2, runs it through Workers AI
// Whisper, and writes the transcript where the rest of the capture bundle
// lives: `transcript.json` + `transcript.vtt` artifacts under the same
// session prefix, a `postprocessing.json` enrichment the captures metadata
// viewer already reads, and a ticket message carrying the transcript text.
//
// `@cf/openai/whisper-large-v3-turbo` accepts base64-encoded audio
// (`{audio: string}`) and decodes common containers (webm/mp4 included)
// server-side — the classic `@cf/openai/whisper` only takes a byte array,
// which balloons the binding payload ~4x for video-sized files.
//
// Failure contract: this module never throws and never blocks ticket
// creation — a missing AI binding, an oversized recording, or a model
// error returns a status and the caller moves on.

import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import { supportTicketAttachments } from "./schema.js";
import { addTicketMessage, updateTicket } from "./support-tickets.js";

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
const SUMMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct" as const;

/** Payload cap for a single Whisper call — beyond this we skip rather than
 *  risk a binding-level request failure on multi-minute captures. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const MAX_TITLE_CHARS = 140;

export interface CaptureTranscriptJob {
  organizationId: string;
  /** Ticket + event the transcript artifacts attach to. */
  ticketId: string;
  eventId: string;
  /** R2 key of the video/audio object to transcribe. */
  recordingR2Key: string;
  /**
   * R2 prefix the transcript artifacts land under —
   * `${org}/capture/${sessionId}` for capture sessions,
   * `${org}/capture/feedback-${ticketId}` for member feedback.
   */
  artifactPrefix: string;
  /** Public API origin used to build artifact URLs. */
  origin: string;
  /** When true, replace the ticket's placeholder title with an AI summary. */
  regenerateTitle?: boolean;
}

export type CaptureTranscriptResult =
  | { status: "written"; text: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type WhisperOutput =
  AiModels["@cf/openai/whisper-large-v3-turbo"]["postProcessedOutputs"];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function padNumber(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatVttTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${padNumber(h)}:${padNumber(m)}:${padNumber(s)}.${padNumber(ms, 3)}`;
}

/** Fallback VTT when the model returns segments but no `vtt` field. */
function buildVttFromSegments(segments: WhisperOutput["segments"]): string {
  const rows = (segments ?? []).filter(
    (segment): segment is { start: number; end: number; text: string } =>
      typeof segment.start === "number" &&
      typeof segment.end === "number" &&
      typeof segment.text === "string" &&
      segment.text.trim().length > 0
  );
  if (rows.length === 0) return "";
  const cues = rows
    .map(
      (segment) =>
        `${formatVttTimestamp(segment.start)} --> ${formatVttTimestamp(segment.end)}\n${segment.text.trim()}`
    )
    .join("\n\n");
  return `WEBVTT\n\n${cues}\n`;
}

function sanitizeTitle(raw: string): string {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const cleaned = firstLine.replace(/^["'`*\s#-]+|["'`*\s.]+$/g, "").trim();
  if (cleaned.length < 4) return "";
  return cleaned.length > MAX_TITLE_CHARS
    ? cleaned.slice(0, MAX_TITLE_CHARS).trim()
    : cleaned;
}

/**
 * Transcribe a stored capture recording and attach the result to the
 * ticket. Never throws — returns a status so callers can schedule it with
 * `ctx.waitUntil` (or await it inline) without risking the request.
 */
export async function transcribeCaptureRecording(
  db: D1Client,
  env: WorkerEnv,
  job: CaptureTranscriptJob
): Promise<CaptureTranscriptResult> {
  try {
    const ai = env.AI;
    const bucket = env.ATTACHMENTS_BUCKET;
    if (!ai || !bucket) {
      return { status: "skipped", reason: "ai-binding-missing" };
    }

    const object = await bucket.get(job.recordingR2Key);
    if (!object) {
      return { status: "skipped", reason: "recording-missing" };
    }
    const audioBytes = new Uint8Array(await object.arrayBuffer());
    if (audioBytes.byteLength === 0) {
      return { status: "skipped", reason: "recording-empty" };
    }
    if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
      return { status: "skipped", reason: "recording-too-large" };
    }

    const output: WhisperOutput = await ai.run(WHISPER_MODEL, {
      audio: bytesToBase64(audioBytes),
      task: "transcribe",
      vad_filter: true,
    });

    const text = output.text?.trim() ?? "";
    const vtt = output.vtt?.trim()
      ? output.vtt.trim()
      : buildVttFromSegments(output.segments);

    const generatedAt = new Date().toISOString();
    const transcriptJson = {
      text,
      vtt: vtt.length > 0 ? vtt : null,
      wordCount: output.word_count ?? null,
      language: output.transcription_info?.language ?? null,
      languageProbability:
        output.transcription_info?.language_probability ?? null,
      durationSeconds: output.transcription_info?.duration ?? null,
      segments: output.segments ?? [],
      model: WHISPER_MODEL,
      sourceR2Key: job.recordingR2Key,
      generatedAt,
    };

    const encoder = new TextEncoder();
    const artifacts: {
      type: "transcript" | "debugger_json";
      fileName: string;
      contentType: string;
      body: Uint8Array;
    }[] = [
      {
        type: "transcript",
        fileName: "transcript.json",
        contentType: "application/json",
        body: encoder.encode(JSON.stringify(transcriptJson, null, 2)),
      },
      // The captures metadata viewer surfaces `postprocessing.json` under
      // the `postprocessing` key — the transcript rides that slot so
      // `…/captures/{ticketId}/metadata` exposes it without a new route.
      {
        type: "debugger_json",
        fileName: "postprocessing.json",
        contentType: "application/json",
        body: encoder.encode(
          JSON.stringify(
            {
              transcript: {
                text,
                wordCount: transcriptJson.wordCount,
                language: transcriptJson.language,
                durationSeconds: transcriptJson.durationSeconds,
                model: WHISPER_MODEL,
                generatedAt,
              },
            },
            null,
            2
          )
        ),
      },
    ];
    if (vtt.length > 0) {
      artifacts.push({
        type: "transcript",
        fileName: "transcript.vtt",
        contentType: "text/vtt",
        body: encoder.encode(vtt),
      });
    }

    await Promise.all(
      artifacts.map(async (artifact) => {
        const r2Key = `${job.artifactPrefix}/${artifact.type}/${artifact.fileName}`;
        await bucket.put(r2Key, artifact.body, {
          httpMetadata: { contentType: artifact.contentType },
        });
        const attachmentId = crypto.randomUUID();
        await db.insert(supportTicketAttachments).values({
          id: attachmentId,
          organizationId: job.organizationId,
          ticketId: job.ticketId,
          eventId: job.eventId,
          type: artifact.type,
          contentType: artifact.contentType,
          r2Key,
          size: artifact.body.byteLength,
          url: `${job.origin}/support/capture/artifacts/${attachmentId}`,
          fileName: artifact.fileName,
          createdAt: generatedAt,
        });
      })
    );

    if (text.length > 0) {
      await addTicketMessage(
        db,
        job.organizationId,
        job.ticketId,
        {
          direction: "outbound",
          textContent: `Transcript of the attached recording:\n\n${text}`,
          markdownContent: `**Transcript of the attached recording**\n\n${text}`,
          channel: "capture",
          actorType: "automation",
          subType: "capture_transcript",
          runAutoresponders: false,
          reopenOnCustomerReply: false,
        },
        env
      );

      if (job.regenerateTitle) {
        const summary = await ai.run(SUMMARY_MODEL, {
          messages: [
            {
              role: "system",
              content:
                "You write concise bug-report titles from a reporter's narrated transcript. Reply with the title only — no quotes, no punctuation at the end, at most 12 words.",
            },
            {
              role: "user",
              content: `Transcript:\n${text.slice(0, 4000)}`,
            },
          ],
          max_tokens: 40,
        });
        const title = sanitizeTitle(summary.response ?? "");
        if (title.length > 0) {
          await updateTicket(
            db,
            job.organizationId,
            job.ticketId,
            { title, actorType: "automation" },
            env
          );
        }
      }
    }

    return { status: "written", text };
  } catch (error) {
    console.error("capture transcription failed", {
      ticketId: job.ticketId,
      recordingR2Key: job.recordingR2Key,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Eye, Play } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api } from "@/lib/api";
import {
  deviceInfoPairs,
  parseConsoleEntries,
  parseNetworkEntries,
  parseUserEventEntries,
  type ConsoleEntry,
  type NetworkEntry,
  type UserEventEntry,
} from "@/lib/capture-artifacts";

interface CaptureFrame {
  url: string;
  type: string;
  fileName: string | null;
}

interface TranscriptSegment {
  /** Seconds from video t=0 — clicking a segment seeks the player. */
  startSec: number;
  endSec: number | null;
  text: string;
}

interface CaptureTranscript {
  text: string | null;
  segments: TranscriptSegment[];
}

interface CaptureBundle {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  events: UserEventEntry[];
  frames: CaptureFrame[];
  deviceInfo: { key: string; value: string }[];
  /** Epoch ms the recording started — when present, every event
   * timestamp maps onto video time directly. */
  recordingStartedAtMs: number | null;
  viewCount: number | null;
  lastViewedAt: string | null;
  transcript: CaptureTranscript | null;
  hasAny: boolean;
}

/** Sync window for "Sync logs to video time" — entries within ±3s of the
 * playhead stay visible while the rest are filtered out. */
const SYNC_WINDOW_SEC = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch ms from an ISO string or an epoch-ms number/numeric string. */
function parseTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

const RECORDING_START_KEYS = [
  "recordingStartedAtMs",
  "recordingStartedAt",
  "recording_started_at",
  "recordingStartMs",
  "recordingStart",
];

/** The capture session's recording anchor — read defensively across the
 * metadata records since different producers write it under different
 * keys (and some nest it under a `recording`/`video` object). */
function readRecordingStartedAtMs(
  records: (Record<string, unknown> | null)[]
): number | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of RECORDING_START_KEYS) {
      const ms = parseTimeMs(record[key]);
      if (ms !== null) return ms;
    }
    for (const nestKey of ["recording", "video"]) {
      const nested = record[nestKey];
      if (!isRecord(nested)) continue;
      for (const key of [...RECORDING_START_KEYS, "startedAt", "startedAtMs"]) {
        const ms = parseTimeMs(nested[key]);
        if (ms !== null) return ms;
      }
    }
  }
  return null;
}

/** PILE-669 — view telemetry rides the same loose metadata records. */
function readViewStats(records: (Record<string, unknown> | null)[]): {
  viewCount: number | null;
  lastViewedAt: string | null;
} {
  let viewCount: number | null = null;
  let lastViewedAt: string | null = null;
  for (const record of records) {
    if (!record) continue;
    viewCount ??=
      num(record.viewCount) ?? num(record.view_count) ?? num(record.views);
    lastViewedAt ??= str(record.lastViewedAt) ?? str(record.last_viewed_at);
  }
  return { viewCount, lastViewedAt };
}

/** PILE-664 — Whisper transcript lands in `postprocessing.transcript`
 * (see capture-transcript.ts). Segments carry `start`/`end` seconds so a
 * click can seek the recording straight to the spoken moment. */
function parseTranscript(
  postprocessing: Record<string, unknown> | null
): CaptureTranscript | null {
  if (!postprocessing) return null;
  const raw = postprocessing.transcript ?? postprocessing.transcription;
  const container = isRecord(raw)
    ? raw
    : Array.isArray(raw)
      ? { segments: raw }
      : null;
  if (!container) return null;
  const text = str(container.text) ?? null;
  const rawSegments = Array.isArray(container.segments)
    ? container.segments
    : Array.isArray(container.cues)
      ? container.cues
      : [];
  const segments: TranscriptSegment[] = [];
  for (const segment of rawSegments) {
    if (!isRecord(segment)) continue;
    const startMs = num(segment.startMs) ?? num(segment.offsetMs);
    const startSec =
      num(segment.startSec) ??
      num(segment.start) ??
      num(segment.startTime) ??
      num(segment.offsetSec) ??
      (startMs !== null ? startMs / 1000 : null);
    const segmentText = str(segment.text) ?? str(segment.content);
    if (startSec === null || !segmentText) continue;
    segments.push({
      startSec,
      endSec: num(segment.endSec) ?? num(segment.end),
      text: segmentText,
    });
  }
  if (!text && segments.length === 0) return null;
  return { text, segments };
}

/** Earliest timestamp across every capture stream — the fallback anchor
 * when the bundle carries no explicit `recordingStartedAt`. */
function earliestEventTimestampMs(data: CaptureBundle): number | null {
  let earliest = Number.POSITIVE_INFINITY;
  const visit = (timestamp: string | null) => {
    if (!timestamp) return;
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms) && ms < earliest) earliest = ms;
  };
  for (const entry of data.console) visit(entry.timestamp);
  for (const entry of data.network) visit(entry.timestamp);
  for (const entry of data.events) visit(entry.timestamp);
  return Number.isFinite(earliest) ? earliest : null;
}

/** `mm:ss` for video offsets and the sync indicator. */
function formatVideoTime(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatLastViewed(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

/** Cap-style seek pill — the mm:ss offset a console/network/click entry
 * fired at; clicking jumps the recording to that moment. */
function SeekButton({
  offsetSec,
  timestamp,
  onSeek,
}: {
  offsetSec: number;
  timestamp: string | null;
  onSeek: (offsetSec: number) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon={<Play size={10} weight="fill" />}
      className="shrink-0 font-mono"
      title={
        timestamp
          ? `Seek recording to ${formatVideoTime(offsetSec)} — ${timestamp}`
          : `Seek recording to ${formatVideoTime(offsetSec)}`
      }
      aria-label={`Seek recording to ${formatVideoTime(offsetSec)}`}
      onClick={() => onSeek(offsetSec)}
    >
      {formatVideoTime(offsetSec)}
    </Button>
  );
}

/** Jam-parity artifact panel on a support ticket: pulls the standard
 * capture artifacts (console trail, network waterfall, click/event
 * trail, frames + recordings, device info) via the capture viewer
 * endpoints and renders whatever the ticket actually has — a
 * member-feedback ticket lands the same bundle a Jam capture does.
 *
 * Cap-style timestamp-anchored triage: when the bundle has a video, each
 * entry's timestamp maps to a video offset (anchored at
 * `recordingStartedAt` when present, else the earliest event) and gets a
 * seek pill; "Sync logs to video time" narrows every stream to a ±3s
 * window around the playhead. */
export function TicketCaptures({ ticketId }: { ticketId: string }) {
  const workspace = useWorkspace();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [syncToVideo, setSyncToVideo] = useState(false);
  const capture = useQuery({
    queryKey: wsKey(workspace.id, "ticket-capture", ticketId),
    staleTime: 60_000,
    queryFn: async (): Promise<CaptureBundle | null> => {
      const path = { organizationId: workspace.id, ticketId };
      const eventsFor = async (
        route:
          | "/workspaces/{organizationId}/support/captures/{ticketId}/console"
          | "/workspaces/{organizationId}/support/captures/{ticketId}/network"
          | "/workspaces/{organizationId}/support/captures/{ticketId}/events"
      ): Promise<unknown[] | null> => {
        const res = await api.GET(route, { params: { path } });
        if (!res.response.ok) return null;
        return res.data?.events ?? [];
      };
      const [consoleRaw, networkRaw, eventsRaw, framesRes, metadataRes] =
        await Promise.all([
          eventsFor(
            "/workspaces/{organizationId}/support/captures/{ticketId}/console"
          ),
          eventsFor(
            "/workspaces/{organizationId}/support/captures/{ticketId}/network"
          ),
          eventsFor(
            "/workspaces/{organizationId}/support/captures/{ticketId}/events"
          ),
          api.GET(
            "/workspaces/{organizationId}/support/captures/{ticketId}/frames",
            { params: { path } }
          ),
          api.GET(
            "/workspaces/{organizationId}/support/captures/{ticketId}/metadata",
            { params: { path } }
          ),
        ]);

      const consoleEntries = parseConsoleEntries(consoleRaw ?? []);
      const networkEntries = parseNetworkEntries(networkRaw ?? []);
      const eventEntries = parseUserEventEntries(eventsRaw ?? []);
      const frames = framesRes.response.ok
        ? (framesRes.data?.frames ?? []).filter(
            (frame): frame is CaptureFrame =>
              typeof frame.url === "string" && frame.url.length > 0
          )
        : [];
      const metadata = metadataRes.response.ok
        ? (metadataRes.data?.metadata ?? null)
        : null;
      const eventsSummary = metadataRes.response.ok
        ? (metadataRes.data?.eventsSummary ?? null)
        : null;
      const postprocessing = metadataRes.response.ok
        ? (metadataRes.data?.postprocessing ?? null)
        : null;
      const deviceInfo = metadataRes.response.ok
        ? deviceInfoPairs(metadataRes.data?.deviceInfo)
        : [];
      const metaRecords = [metadata, eventsSummary, postprocessing];
      const recordingStartedAtMs = readRecordingStartedAtMs(metaRecords);
      const { viewCount, lastViewedAt } = readViewStats(metaRecords);
      const transcript = parseTranscript(postprocessing);

      const hasAny =
        consoleEntries.length > 0 ||
        networkEntries.length > 0 ||
        eventEntries.length > 0 ||
        frames.length > 0 ||
        deviceInfo.length > 0;
      if (!hasAny) return null;
      return {
        console: consoleEntries,
        network: networkEntries,
        events: eventEntries,
        frames,
        deviceInfo,
        recordingStartedAtMs,
        viewCount,
        lastViewedAt,
        transcript,
        hasAny,
      };
    },
  });

  const data = capture.data;
  if (!data) return null;

  const firstVideoIndex = data.frames.findIndex(
    (frame) => frame.type === "video"
  );
  const hasVideo = firstVideoIndex >= 0;
  const syncActive = syncToVideo && hasVideo;
  // Video t=0 corresponds to the recording start when the bundle says
  // when it was; otherwise anchor at the earliest captured event so
  // offsets still land on a coherent timeline.
  const anchorMs = data.recordingStartedAtMs ?? earliestEventTimestampMs(data);

  const offsetFor = (timestamp: string | null): number | null => {
    if (!timestamp || anchorMs === null) return null;
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.round((ms - anchorMs) / 1000));
  };

  const inSyncWindow = (timestamp: string | null): boolean => {
    const offset = offsetFor(timestamp);
    return (
      offset !== null && Math.abs(offset - currentTimeSec) <= SYNC_WINDOW_SEC
    );
  };

  const seekTo = (offsetSec: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = offsetSec;
    setCurrentTimeSec(offsetSec);
    video.focus();
    void video.play().catch(() => undefined);
  };

  const visibleEvents = (
    syncActive
      ? data.events.filter((entry) => inSyncWindow(entry.timestamp))
      : data.events
  ).slice(-25);
  const visibleNetwork = (
    syncActive
      ? data.network.filter((entry) => inSyncWindow(entry.timestamp))
      : data.network
  ).slice(-50);
  const visibleConsole = (
    syncActive
      ? data.console.filter((entry) => inSyncWindow(entry.timestamp))
      : data.console
  ).slice(-50);

  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-kumo-default">Capture</h2>
        <Badge variant="neutral">
          {data.console.length +
            data.network.length +
            data.events.length +
            data.frames.length}{" "}
          artifacts
        </Badge>
        {data.viewCount !== null ? (
          <Badge variant="neutral">
            <span className="inline-flex items-center gap-1">
              <Eye size={11} />
              {data.viewCount} {data.viewCount === 1 ? "view" : "views"}
            </span>
          </Badge>
        ) : null}
        {data.lastViewedAt ? (
          <Badge variant="neutral">
            last viewed {formatLastViewed(data.lastViewedAt)}
          </Badge>
        ) : null}
        {hasVideo ? (
          <div className="ml-auto flex items-center gap-2">
            {syncActive ? (
              <Badge variant="secondary">
                ±{SYNC_WINDOW_SEC}s around {formatVideoTime(currentTimeSec)}
              </Badge>
            ) : null}
            <Switch
              label="Sync logs to video time"
              checked={syncToVideo}
              onCheckedChange={setSyncToVideo}
            />
          </div>
        ) : null}
      </div>

      {data.frames.length > 0 ? (
        <section aria-label="Frames" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-kumo-subtle">Frames</h3>
          <div className="flex flex-wrap gap-2">
            {data.frames.map((frame, index) =>
              frame.type === "video" ? (
                <video
                  key={`${frame.url}-${index}`}
                  ref={index === firstVideoIndex ? videoRef : undefined}
                  src={frame.url}
                  controls
                  tabIndex={index === firstVideoIndex ? 0 : undefined}
                  onTimeUpdate={
                    index === firstVideoIndex
                      ? (event) =>
                          setCurrentTimeSec(event.currentTarget.currentTime)
                      : undefined
                  }
                  className="border-kumo-line max-h-48 rounded border"
                />
              ) : (
                <a
                  key={`${frame.url}-${index}`}
                  href={frame.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={frame.url}
                    alt={frame.fileName ?? "Screenshot"}
                    className="border-kumo-line max-h-48 rounded border"
                  />
                </a>
              )
            )}
          </div>
        </section>
      ) : null}

      {data.transcript ? (
        <section aria-label="Transcript" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Transcript</h3>
          {data.transcript.segments.length > 0 ? (
            <ul className="flex flex-col text-xs">
              {data.transcript.segments.map((segment, index) => (
                <li
                  key={index}
                  className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
                >
                  {hasVideo ? (
                    <SeekButton
                      offsetSec={Math.max(0, Math.round(segment.startSec))}
                      timestamp={null}
                      onSeek={seekTo}
                    />
                  ) : (
                    <span className="w-10 shrink-0 font-mono text-kumo-subtle">
                      {formatVideoTime(segment.startSec)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-kumo-default">
                    {segment.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : data.transcript.text ? (
            <p className="whitespace-pre-wrap text-xs text-kumo-default">
              {data.transcript.text}
            </p>
          ) : null}
        </section>
      ) : null}

      {data.deviceInfo.length > 0 ? (
        <section aria-label="Device info" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Device</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
            {data.deviceInfo.map((pair) => (
              <div key={pair.key} className="contents">
                <dt className="text-kumo-subtle">{pair.key}</dt>
                <dd className="truncate text-kumo-default">{pair.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {data.events.length > 0 ? (
        <section aria-label="User events" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">
            Recent actions
          </h3>
          <ul className="flex flex-col text-xs">
            {visibleEvents.map((event, index) => {
              const offsetSec = offsetFor(event.timestamp);
              return (
                <li
                  key={index}
                  className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
                >
                  {hasVideo && offsetSec !== null ? (
                    <SeekButton
                      offsetSec={offsetSec}
                      timestamp={event.timestamp}
                      onSeek={seekTo}
                    />
                  ) : (
                    <span className="shrink-0 font-mono text-kumo-subtle">
                      {event.timestamp?.slice(11, 19) ?? "—"}
                    </span>
                  )}
                  <span className="shrink-0 text-kumo-default">
                    {event.action}
                  </span>
                  <span className="truncate font-mono text-kumo-subtle">
                    {event.target ?? ""}
                  </span>
                </li>
              );
            })}
            {syncActive && visibleEvents.length === 0 ? (
              <li className="py-1 text-kumo-subtle">
                Nothing captured within ±{SYNC_WINDOW_SEC}s of{" "}
                {formatVideoTime(currentTimeSec)}.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {data.network.length > 0 ? (
        <section aria-label="Network requests" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Network</h3>
          <ul className="flex flex-col text-xs">
            {visibleNetwork.map((request, index) => {
              const offsetSec = offsetFor(request.timestamp);
              return (
                <li
                  key={index}
                  className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
                >
                  {hasVideo && offsetSec !== null ? (
                    <SeekButton
                      offsetSec={offsetSec}
                      timestamp={request.timestamp}
                      onSeek={seekTo}
                    />
                  ) : null}
                  <span
                    className={`w-8 shrink-0 font-mono ${
                      request.isError ? "text-kumo-danger" : "text-kumo-subtle"
                    }`}
                  >
                    {request.status ?? "ERR"}
                  </span>
                  <span className="w-12 shrink-0 font-mono text-kumo-default">
                    {request.method}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-kumo-subtle">
                    {request.url}
                  </span>
                  <span className="shrink-0 font-mono text-kumo-subtle">
                    {request.durationMs !== null
                      ? `${Math.round(request.durationMs)}ms`
                      : ""}
                  </span>
                </li>
              );
            })}
            {syncActive && visibleNetwork.length === 0 ? (
              <li className="py-1 text-kumo-subtle">
                Nothing captured within ±{SYNC_WINDOW_SEC}s of{" "}
                {formatVideoTime(currentTimeSec)}.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {data.console.length > 0 ? (
        <section aria-label="Console logs" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Console</h3>
          <ul className="flex flex-col text-xs">
            {visibleConsole.map((entry, index) => {
              const offsetSec = offsetFor(entry.timestamp);
              return (
                <li
                  key={index}
                  className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
                >
                  {hasVideo && offsetSec !== null ? (
                    <SeekButton
                      offsetSec={offsetSec}
                      timestamp={entry.timestamp}
                      onSeek={seekTo}
                    />
                  ) : (
                    <span className="w-12 shrink-0 font-mono text-kumo-subtle">
                      {entry.timestamp?.slice(11, 19) ?? "—"}
                    </span>
                  )}
                  <Badge variant={entry.isError ? "red" : "neutral"}>
                    {entry.level}
                  </Badge>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-kumo-default">
                    {entry.message}
                  </span>
                </li>
              );
            })}
            {syncActive && visibleConsole.length === 0 ? (
              <li className="py-1 text-kumo-subtle">
                Nothing captured within ±{SYNC_WINDOW_SEC}s of{" "}
                {formatVideoTime(currentTimeSec)}.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </LayerCard>
  );
}

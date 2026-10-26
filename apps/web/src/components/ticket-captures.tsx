import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useQuery } from "@tanstack/react-query";

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

interface CaptureBundle {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  events: UserEventEntry[];
  frames: CaptureFrame[];
  deviceInfo: { key: string; value: string }[];
  hasAny: boolean;
}

/** Jam-parity artifact panel on a support ticket: pulls the standard
 * capture artifacts (console trail, network waterfall, click/event
 * trail, frames + recordings, device info) via the capture viewer
 * endpoints and renders whatever the ticket actually has — a
 * member-feedback ticket lands the same bundle a Jam capture does. */
export function TicketCaptures({ ticketId }: { ticketId: string }) {
  const workspace = useWorkspace();
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
      const deviceInfo = metadataRes.response.ok
        ? deviceInfoPairs(metadataRes.data?.deviceInfo)
        : [];

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
        hasAny,
      };
    },
  });

  const data = capture.data;
  if (!data) return null;

  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-kumo-default">Capture</h2>
        <Badge variant="neutral">
          {data.console.length +
            data.network.length +
            data.events.length +
            data.frames.length}{" "}
          artifacts
        </Badge>
      </div>

      {data.frames.length > 0 ? (
        <section aria-label="Frames" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-kumo-subtle">Frames</h3>
          <div className="flex flex-wrap gap-2">
            {data.frames.map((frame, index) =>
              frame.type === "video" ? (
                <video
                  key={`${frame.url}-${index}`}
                  src={frame.url}
                  controls
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
            {data.events.slice(-25).map((event, index) => (
              <li
                key={index}
                className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
              >
                <span className="shrink-0 font-mono text-kumo-subtle">
                  {event.timestamp?.slice(11, 19) ?? "—"}
                </span>
                <span className="shrink-0 text-kumo-default">
                  {event.action}
                </span>
                <span className="truncate font-mono text-kumo-subtle">
                  {event.target ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.network.length > 0 ? (
        <section aria-label="Network requests" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Network</h3>
          <ul className="flex flex-col text-xs">
            {data.network.slice(-50).map((request, index) => (
              <li
                key={index}
                className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
              >
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
            ))}
          </ul>
        </section>
      ) : null}

      {data.console.length > 0 ? (
        <section aria-label="Console logs" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-kumo-subtle">Console</h3>
          <ul className="flex flex-col text-xs">
            {data.console.slice(-50).map((entry, index) => (
              <li
                key={index}
                className="border-kumo-hairline flex items-baseline gap-2 border-b py-1 last:border-b-0"
              >
                <span className="w-12 shrink-0 font-mono text-kumo-subtle">
                  {entry.timestamp?.slice(11, 19) ?? "—"}
                </span>
                <Badge variant={entry.isError ? "red" : "neutral"}>
                  {entry.level}
                </Badge>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-kumo-default">
                  {entry.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </LayerCard>
  );
}

import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useQueries } from "@tanstack/react-query";
import { Fragment } from "react";

/** The Jam move: a capture isn't the video, it's the story under it —
 * console logs, network requests, environment. Fetches the capture's
 * json/log artifacts client-side and renders them as compact panels. */

interface Attachment {
  type: string;
  url?: string | null;
}

type Artifact = Record<string, unknown> | unknown[] | string | null;

async function fetchArtifact(url: string): Promise<Artifact> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  try {
    return JSON.parse(text) as Artifact;
  } catch {
    return text;
  }
}

function artifactEntries(data: Artifact): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null
    );
  }
  if (typeof data === "object" && data !== null) {
    // common capture shapes: {events:[...]}, {logs:[...]}, {requests:[...]}
    for (const key of ["events", "logs", "requests", "entries", "records"]) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        return inner.filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null
        );
      }
    }
    return [data];
  }
  return [];
}

function row(fields: Record<string, string | undefined>) {
  const entries = Object.entries(fields).filter(([, v]) => v);
  if (entries.length === 0) return null;
  return (
    <tr className="border-t border-kumo-line">
      {entries.map(([k, v]) => (
        <td key={k} className="px-3 py-1.5 align-top">
          <span className="text-kumo-subtle mr-2 text-xs">{k}</span>
          <span className="text-xs text-kumo-default break-all">{v}</span>
        </td>
      ))}
    </tr>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <LayerCard>
      <div className="border-b border-kumo-line px-4 py-2.5">
        <span className="text-sm font-medium text-kumo-default">{title}</span>
      </div>
      <table className="w-full text-left">
        <tbody>{children}</tbody>
      </table>
    </LayerCard>
  );
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

export function TechnicalPanel({ attachments }: { attachments: Attachment[] }) {
  const artifacts = attachments.filter(
    (a) => a.url && a.type !== "video" && a.type !== "screenshot"
  );
  const results = useQueries({
    queries: artifacts.map((a) => ({
      queryKey: ["capture-artifact", a.url],
      queryFn: () => fetchArtifact(a.url!),
      staleTime: Infinity,
    })),
  });

  const sections = artifacts.map((att, i) => {
    const data = results[i]?.data;
    if (data === undefined || data === null) return null;
    const entries = artifactEntries(data).slice(0, 50);
    if (entries.length === 0) return null;

    if (att.type === "network") {
      return (
        <Section key={att.type} title="Network requests">
          {entries.map((e, j) => (
            <Fragment key={j}>
              {row({
                method: s(e.method) ?? s(e.httpMethod),
                url: s(e.url) ?? s(e.requestUrl) ?? s(e.name),
                status:
                  s(e.status) ??
                  s(e.statusCode) ??
                  (typeof e.status === "number" ? String(e.status) : undefined),
                duration:
                  typeof e.duration === "number"
                    ? `${e.duration}ms`
                    : s(e.duration),
              })}
            </Fragment>
          ))}
        </Section>
      );
    }
    if (att.type === "log" || att.type === "debugger_json") {
      return (
        <Section
          key={att.type}
          title={att.type === "log" ? "Console" : "Debug context"}
        >
          {entries.map((e, j) => (
            <Fragment key={j}>
              {row({
                level: s(e.level) ?? s(e.severity) ?? s(e.type),
                message: s(e.message) ?? s(e.text) ?? s(e.msg) ?? s(e.value),
                time: s(e.timestamp) ?? s(e.time),
              })}
            </Fragment>
          ))}
        </Section>
      );
    }
    return (
      <Section key={att.type} title={att.type}>
        {entries.map((e, j) => (
          <Fragment key={j}>
            {row(
              Object.fromEntries(
                Object.entries(e)
                  .filter(
                    ([, v]) => typeof v === "string" || typeof v === "number"
                  )
                  .slice(0, 6)
                  .map(([k, v]) => [k, String(v)])
              )
            )}
          </Fragment>
        ))}
      </Section>
    );
  });

  const visible = sections.filter(Boolean);
  if (visible.length === 0) return null;

  return <div className="flex flex-col gap-4">{visible}</div>;
}

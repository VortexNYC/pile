// Server-rendered HTML variant of GET /status (follow-up to PILE-339/389).
// Same probe result as the JSON payload — one source of truth, two
// representations negotiated on Accept. Everything is inlined (no external
// CSS/JS/CDN) so the page still renders while the app is degraded.

export interface StatusComponentReport {
  status: "operational" | "degraded";
  latencyMs?: number;
}

export interface PublicStatusReport {
  status: "operational" | "degraded";
  version: string;
  sha: string | null;
  timestamp: string;
  components: {
    api: StatusComponentReport;
    database: StatusComponentReport;
    durableObjects: StatusComponentReport;
    storage: StatusComponentReport;
  };
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const COMPONENT_LABELS: ReadonlyArray<
  readonly [keyof PublicStatusReport["components"], string]
> = [
  ["api", "API"],
  ["database", "Database"],
  ["durableObjects", "Durable Objects"],
  ["storage", "Storage"],
];

export function renderStatusPageHtml(report: PublicStatusReport): string {
  const operational = report.status === "operational";
  const bannerText = operational
    ? "All systems operational"
    : "Some systems are degraded";

  const rows = COMPONENT_LABELS.map(([key, label]) => {
    const component = report.components[key];
    const state = component.status === "operational";
    const latency =
      typeof component.latencyMs === "number"
        ? `<span class="latency">${component.latencyMs} ms</span>`
        : "";
    return `<div class="row"><span class="name">${label}</span><span class="right"><span class="pill ${
      state ? "ok" : "bad"
    }">${state ? "Operational" : "Degraded"}</span>${latency}</span></div>`;
  }).join("\n  ");

  const shaText = report.sha ? report.sha.slice(0, 7) : "unknown";
  const meta = `version ${escapeHtml(report.version)} · sha ${escapeHtml(
    shaText
  )} · checked ${escapeHtml(report.timestamp)}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Pile status — ${operational ? "operational" : "degraded"}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;background:#0a0a0a;color:#eee}
  h1{font-size:18px;font-weight:600;margin:0 0 20px}
  h1 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#3fb950;margin-right:8px;vertical-align:baseline}
  .banner{padding:14px 16px;border-radius:8px;font-size:15px;font-weight:600;margin-bottom:24px;border:1px solid}
  .banner.ok{background:#0f1f0f;border-color:#2a5a2a;color:#7ee787}
  .banner.bad{background:#2a1512;border-color:#6e2f22;color:#ffa198}
  .row{display:flex;justify-content:space-between;align-items:center;padding:12px 4px;border-bottom:1px solid #1e1e1e;font-size:14px}
  .row:last-child{border-bottom:0}
  .name{color:#ccc}
  .right{display:flex;align-items:center;gap:10px}
  .latency{color:#666;font-size:12px;font-variant-numeric:tabular-nums}
  .pill{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid}
  .pill.ok{color:#7ee787;border-color:#2a5a2a;background:#0f1f0f}
  .pill.bad{color:#ffa198;border-color:#6e2f22;background:#2a1512}
  .meta{margin-top:28px;color:#666;font-size:12px}
  .meta .hint{margin-top:6px;color:#4a4a4a}
  a{color:#888}
</style></head><body>
<h1><span class="dot" style="background:${
    operational ? "#3fb950" : "#f85149"
  }"></span>Pile status</h1>
<div class="banner ${operational ? "ok" : "bad"}">${bannerText}</div>
<div class="components">
  ${rows}
</div>
<div class="meta">${meta}<div class="hint">Auto-refreshes every 60 seconds. JSON: <a href="/status">/status</a> with <code>Accept: application/json</code>.</div></div>
</body></html>`;
}

/** Parsers for the loose `unknown[]` event arrays the capture viewer
 * endpoints return — the artifact files are written by several
 * producers (member feedback, Jam webhooks, the capture SDK, the CLI),
 * so fields are read defensively and unknown entries are skipped. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ConsoleEntry {
  level: string;
  message: string;
  isError: boolean;
  timestamp: string | null;
}

export function parseConsoleEntries(raw: unknown[]): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const message =
      str(item.console_value) ?? str(item.console_message) ?? str(item.message);
    if (!message) continue;
    entries.push({
      level: str(item.console_level) ?? str(item.level) ?? "log",
      message,
      isError: item.is_error === true,
      timestamp: str(item.timestamp),
    });
  }
  return entries;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  isError: boolean;
  timestamp: string | null;
}

export function parseNetworkEntries(raw: unknown[]): NetworkEntry[] {
  const entries: NetworkEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const url = str(item.network_url) ?? str(item.url);
    if (!url) continue;
    const status = num(item.network_status) ?? num(item.status);
    entries.push({
      method: (
        str(item.network_method) ??
        str(item.method) ??
        "GET"
      ).toUpperCase(),
      url,
      status,
      durationMs: num(item.duration_ms) ?? num(item.duration),
      isError: item.is_error === true || (status !== null && status >= 400),
      timestamp: str(item.timestamp),
    });
  }
  return entries;
}

export interface UserEventEntry {
  action: string;
  target: string | null;
  timestamp: string | null;
}

export function parseUserEventEntries(raw: unknown[]): UserEventEntry[] {
  const entries: UserEventEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const action =
      str(item.interactivity_action) ??
      str(item.action) ??
      str(item.event_type) ??
      str(item.type);
    if (!action) continue;
    entries.push({
      action,
      target: str(item.target) ?? str(item.selector),
      timestamp: str(item.timestamp),
    });
  }
  return entries;
}

/** Flatten the device-info blob into a short list of displayable
 * key/value pairs — nested objects are rendered as compact strings. */
export function deviceInfoPairs(
  deviceInfo: Record<string, unknown> | null | undefined
): { key: string; value: string }[] {
  if (!deviceInfo) return [];
  const pairs: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(deviceInfo)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") {
      pairs.push({ key, value: String(value) });
      continue;
    }
    if (typeof value === "boolean") {
      pairs.push({ key, value: value ? "yes" : "no" });
      continue;
    }
    if (isRecord(value)) {
      const flat = Object.values(value)
        .filter(
          (v): v is string | number =>
            typeof v === "string" || typeof v === "number"
        )
        .map(String)
        .join(" × ");
      if (flat.length > 0) pairs.push({ key, value: flat });
    }
  }
  return pairs;
}

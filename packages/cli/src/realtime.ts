import { isJsonObject } from "./cli.js";

type JsonObject = { readonly [key: string]: unknown };

export type RealtimeMessage = { readonly data: unknown };

// Minimal structural socket so the client works against the Node >= 22 /
// browser `WebSocket` and trivial fakes in tests.
export type RealtimeSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "error" | "close",
    listener: () => void
  ): void;
  addEventListener(
    type: "message",
    listener: (event: RealtimeMessage) => void
  ): void;
};

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

export type RealtimeState = "connecting" | "open" | "reconnecting";

export type RealtimeClientOptions = {
  readonly url: string;
  readonly createSocket: RealtimeSocketFactory;
  readonly onEvent: (event: JsonObject) => void;
  readonly onStateChange?: (state: RealtimeState) => void;
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
  };
  readonly pingIntervalMs?: number;
  readonly random?: () => number;
};

// `GET /workspaces/{org}/realtime` authenticates browser-style clients via
// `?token=` (PILE-247) — CLI uses the same param so no header handling is
// needed on the upgrade request.
export function realtimeSocketUrl(
  baseUrl: string,
  organizationId: string,
  token: string
): string {
  const url = new URL(
    `/workspaces/${organizationId}/realtime`,
    `${baseUrl.replace(/\/$/u, "")}/`
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

export function defaultRealtimeSocketFactory(): RealtimeSocketFactory | null {
  if (typeof WebSocket !== "function") return null;
  return (url) => {
    const ws = new WebSocket(url);
    return {
      get readyState() {
        return ws.readyState;
      },
      send: (data) => ws.send(data),
      close: () => ws.close(),
      addEventListener(type, listener) {
        ws.addEventListener(type, (event) => {
          listener({
            data: event instanceof MessageEvent ? event.data : undefined,
          });
        });
      },
    };
  };
}

// Exponential backoff capped at maxMs, plus up to one initial-interval of
// jitter so reconnecting fleets don't stampede.
export function reconnectDelayMs(
  attempt: number,
  options?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly random?: () => number;
  }
): number {
  const initial = options?.initialMs ?? 1000;
  const max = options?.maxMs ?? 30_000;
  const backoff = Math.min(max, initial * 2 ** attempt);
  return backoff + (options?.random ?? Math.random)() * initial;
}

function parseMessageData(data: unknown): JsonObject | null {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            )
          : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Subscribes to a workspace's realtime event stream. On any failure the
// socket is re-established with exponential backoff + jitter; callers decide
// what to poll in the meantime via `isOpen` / `onStateChange`.
export class RealtimeClient {
  private socket: RealtimeSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = false;
  private attempts = 0;
  private stopped = false;
  private open = false;

  constructor(private readonly options: RealtimeClientOptions) {}

  get isOpen(): boolean {
    return this.open;
  }

  start(): void {
    this.options.onStateChange?.("connecting");
    this.connect();
  }

  close(): void {
    this.stopped = true;
    this.open = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: RealtimeSocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.stopped) {
        socket.close();
        return;
      }
      this.open = true;
      this.attempts = 0;
      this.awaitingPong = false;
      this.options.onStateChange?.("open");
      this.startPing();
    });
    socket.addEventListener("message", (event) => {
      this.awaitingPong = false;
      const parsed = parseMessageData(event.data);
      if (parsed !== null) this.options.onEvent(parsed);
    });
    socket.addEventListener("error", () => {
      // The close event always follows; the reconnect happens there.
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.open = false;
      }
      this.stopPing();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = reconnectDelayMs(this.attempts, {
      ...this.options.reconnect,
      random: this.options.random,
    });
    this.attempts += 1;
    this.options.onStateChange?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // The DO answers {"type":"ping"} with {"type":"pong"}; a missed pong means
  // the socket is half-dead — close it so the normal reconnect path runs.
  private startPing(): void {
    const interval = this.options.pingIntervalMs ?? 30_000;
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket === null || !this.open) return;
      if (this.awaitingPong) {
        socket.close();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
        this.awaitingPong = true;
      } catch {
        socket.close();
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }
}

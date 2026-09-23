export type CaptureAttachmentType =
  | "screenshot"
  | "video"
  | "debugger_json"
  | "log"
  | "network";

export type CapturePriority = "low" | "medium" | "high" | "urgent";
export type CaptureVisibility = "public" | "private";

export type DebuggerActionType =
  | "click"
  | "input"
  | "change"
  | "submit"
  | "keydown"
  | "navigation";

export interface DebuggerActionEvent {
  kind: "action";
  timestamp: number;
  actionType: DebuggerActionType | string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface DebuggerConsoleEvent {
  kind: "console";
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface DebuggerNetworkEvent {
  kind: "network";
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

export interface DebuggerErrorEvent {
  kind: "error";
  timestamp: number;
  message: string;
  stack?: string;
  source?: "exception" | "unhandledrejection";
}

export type DebuggerEvent =
  | DebuggerActionEvent
  | DebuggerConsoleEvent
  | DebuggerNetworkEvent
  | DebuggerErrorEvent;

export interface BugReportDebuggerPayload {
  actions: Array<{
    type: string;
    target?: string;
    timestamp: string;
    offset: number | null;
    metadata?: Record<string, unknown>;
  }>;
  logs: Array<{
    level: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    timestamp: string;
    offset: number | null;
    metadata?: Record<string, unknown>;
  }>;
  networkRequests: Array<{
    method: string;
    url: string;
    status?: number;
    duration?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string;
    responseBody?: string;
    timestamp: string;
    offset: number | null;
  }>;
  errors: Array<{
    message: string;
    stack?: string;
    source?: string;
    timestamp: string;
    offset: number | null;
  }>;
}

export interface CaptureInitOptions {
  publicKey: string;
  endpoint?: string;
  reference?: string;
  /**
   * How much pre-report history to include when no explicit session is
   * active. The recorder buffers continuously from init() so the bug that
   * already happened is still captured. Default 60s.
   */
  lookbackMs?: number;
  /** Record the screen during start()/stop() sessions via getDisplayMedia. */
  video?: boolean;
  /** Capture text request/response bodies (sanitized). Default true. */
  networkBodies?: boolean;
}

export interface CaptureStartOptions {
  /** Record screen video for this session (prompts the user). */
  video?: boolean;
  /** Override the configured lookback window for this session. */
  lookbackMs?: number;
}

export interface CaptureStopOptions {
  email: string;
  fullName?: string;
  title?: string;
  description?: string;
  priority?: CapturePriority;
  tags?: string[];
  url?: string;
  visibility?: CaptureVisibility;
  screenshot?: Blob;
  metadata?: Record<string, unknown>;
}

export interface CaptureResult {
  ticketId: string;
  shareUrl?: string;
  recordingUrl: string;
}

export interface CaptureArtifact {
  attachmentType: CaptureAttachmentType;
  fileName: string;
  blob: Blob;
  contentEncoding?: string;
}

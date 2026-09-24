export type CaptureAttachmentType =
  | "screenshot"
  | "video"
  | "debugger_json"
  | "log"
  | "network"
  | "replay";

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

export interface DebuggerNetworkTiming {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
  download?: number;
}

export interface DebuggerGraphqlInfo {
  operationName?: string;
  operationType?: "query" | "mutation" | "subscription";
  hasErrors?: boolean;
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
  /** DevTools-grade timing phases from PerformanceResourceTiming. */
  timing?: DebuggerNetworkTiming;
  /** GraphQL detection: operation name/type + errors-in-200 flag. */
  graphql?: DebuggerGraphqlInfo;
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
    timing?: DebuggerNetworkTiming;
    graphql?: DebuggerGraphqlInfo;
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
  /**
   * Publishable capture key (pil_…) provisioned via the workspace API.
   * Required unless `linkToken` is set.
   */
  publicKey?: string;
  /**
   * Recording-link token (capl_…) — mints capture sessions under the link's
   * constraints (expiry, session cap, optional challenge). Sessions minted
   * this way are always public so the recorder gets a share URL back.
   */
  linkToken?: string;
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
  /**
   * Record the DOM via rrweb — deterministic session replay without a
   * permission prompt. Lazily imports rrweb only when enabled. Default
   * false.
   */
  replay?: boolean;
  /** Mask all input values in the DOM replay. Default true. */
  replayMaskInputs?: boolean;
  /**
   * Extra CSS selectors to blur in DOM replay — string, list, or a function
   * evaluated at recorder start (Jam-style `blurSelectors`). Industry
   * privacy selectors (FullStory/Hotjar/Sentry/LogRocket/Clarity/rrweb/…)
   * and `[data-pile-blur]` are always honored.
   */
  blurSelectors?: string | string[] | (() => string | string[]);
  /** Capture text request/response bodies (sanitized). Default true. */
  networkBodies?: boolean;
}

export interface CaptureStartOptions {
  /** Record screen video for this session (prompts the user). */
  video?: boolean;
  /** Record DOM replay for this session via rrweb. */
  replay?: boolean;
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

/** `report()` options — screenshot may be a blob or "auto" (SDK takes it). */
export type CaptureReportOptions = Omit<CaptureStopOptions, "screenshot"> & {
  screenshot?: Blob | "auto";
};

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

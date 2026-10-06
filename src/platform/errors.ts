import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Unauthorized" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Not found" },
  CONFLICT: { status: 409, message: "Conflict" },
  USAGE_LIMIT: { status: 402, message: "Usage limit reached" },
  UNPROCESSABLE_CONTENT: { status: 422, message: "Unprocessable content" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  UPGRADE_REQUIRED: { status: 426, message: "Upgrade Required" },
  RATE_LIMITED: { status: 429, message: "Rate limit exceeded" },
  AGENT_ERROR: { status: 502, message: "Agent provider error" },
  CONFIG_ERROR: { status: 500, message: "Configuration error" },
  INTERNAL_ERROR: { status: 500, message: "Internal error" },
  CAPTURE_CHALLENGE_REQUIRED: {
    status: 403,
    message: "A challenge token is required",
  },
  WIDGET_CHALLENGE_REQUIRED: {
    status: 403,
    message: "A challenge token is required",
  },
  SSO_REQUIRED: {
    status: 403,
    message: "Workspace requires SSO sign-in",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface VortexErrorCode {
  code: ErrorCode;
  status: number;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class VortexError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor({ code, status, message, hint, details }: VortexErrorCode) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }

  toBody(): string {
    return JSON.stringify(this.toJSON());
  }

  static fromCode(code: ErrorCode, hint?: string): VortexError {
    const catalog = ERROR_CATALOG[code];
    return new VortexError({
      code,
      status: catalog.status,
      message: catalog.message,
      hint,
    });
  }
}

/** Map an HTTP status onto the catalog code clients already branch on. */
export function errorCodeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 402:
      return "USAGE_LIMIT";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    case 426:
      return "UPGRADE_REQUIRED";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 502:
      return "AGENT_ERROR";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
  }
}

function isDetailsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A VortexError thrown inside a Durable Object loses its prototype across
// the RPC boundary, so `instanceof` misses it. workerd still serializes the
// own properties (code, status, hint, details) — recognize that shape and
// rebuild the error instead of collapsing every DO-side validation failure
// to a 500.
function isSerializedVortexError(
  error: unknown
): error is Error & VortexErrorCode {
  if (!(error instanceof Error)) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return (
    typeof code === "string" &&
    code in ERROR_CATALOG &&
    typeof status === "number"
  );
}

export function toErrorResponse(error: unknown): Response {
  let vortex: VortexError;
  if (error instanceof VortexError) {
    vortex = error;
  } else if (error instanceof HTTPException) {
    const code = errorCodeFromStatus(error.status);
    const catalog = ERROR_CATALOG[code];
    vortex = new VortexError({
      code,
      status: error.status,
      // Keep 5xx internals off the wire; 4xx can surface the exception text.
      message:
        error.status < 500 ? error.message || catalog.message : catalog.message,
    });
    if (error.status >= 500) {
      console.error("unhandled HTTPException", {
        status: error.status,
        message: error.message,
      });
    }
  } else if (error instanceof ZodError) {
    vortex = new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid request",
      hint: error.message,
    });
  } else if (isSerializedVortexError(error)) {
    const catalog = ERROR_CATALOG[error.code];
    const status =
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status < 600
        ? error.status
        : catalog.status;
    vortex = new VortexError({
      code: error.code,
      status,
      // Keep 5xx internals off the wire; 4xx can surface the DO's message.
      message:
        status < 500 ? error.message || catalog.message : catalog.message,
      hint: typeof error.hint === "string" ? error.hint : undefined,
      details: isDetailsRecord(error.details) ? error.details : undefined,
    });
    if (status >= 500) {
      console.error("unhandled serialized error", {
        code: error.code,
        status,
        message: error.message,
      });
    }
  } else {
    console.error("unhandled error", {
      message: error instanceof Error ? error.message : String(error),
    });
    vortex = new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Internal error",
    });
  }

  return new Response(vortex.toBody(), {
    status: vortex.status,
    headers: {
      "Content-Type": "application/json",
      "X-Pile-Error-Code": vortex.code,
    },
  });
}

import { ZodError } from "zod";

export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Unauthorized" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Not found" },
  CONFLICT: { status: 409, message: "Conflict" },
  UNPROCESSABLE_CONTENT: { status: 422, message: "Unprocessable content" },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests" },
  AGENT_ERROR: { status: 502, message: "Agent provider error" },
  CONFIG_ERROR: { status: 500, message: "Configuration error" },
  INTERNAL_ERROR: { status: 500, message: "Internal error" },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface VortexErrorCode {
  code: ErrorCode;
  status: number;
  message: string;
  hint?: string;
}

export class VortexError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | undefined;

  constructor({ code, status, message, hint }: VortexErrorCode) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
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

export function toErrorResponse(error: unknown): Response {
  let vortex: VortexError;
  if (error instanceof VortexError) {
    vortex = error;
  } else if (error instanceof ZodError) {
    vortex = new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid request",
      hint: error.message,
    });
  } else {
    vortex = new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Internal error",
      hint: error instanceof Error ? error.message : undefined,
    });
  }

  return new Response(vortex.toBody(), {
    status: vortex.status,
    headers: {
      "Content-Type": "application/json",
      "X-Vortex-Error-Code": vortex.code,
    },
  });
}

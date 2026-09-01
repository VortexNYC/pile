export interface VortexErrorCode {
  code: string;
  status: number;
  message: string;
  hint?: string;
}

export class VortexError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;

  constructor({ code, status, message, hint }: VortexErrorCode) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }

  toJSON(): { code: string; message: string; hint: string | undefined } {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
    };
  }
}

export function toErrorResponse(error: unknown): Response {
  const vortex =
    error instanceof VortexError
      ? error
      : new VortexError({
          code: "INTERNAL_ERROR",
          status: 500,
          message: error instanceof Error ? error.message : "Internal error",
        });

  return new Response(JSON.stringify(vortex.toJSON()), {
    status: vortex.status,
    headers: { "Content-Type": "application/json" },
  });
}

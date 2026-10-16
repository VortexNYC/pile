import createClient from "openapi-fetch";

import type { paths } from "../../../../packages/cli/src/client/types";

export type { paths };

export const api = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "include",
});

export class ApiError extends Error {
  readonly status: number;
  /** The error body's `details` payload (e.g. stage-gate blockingSubSteps). */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull a human message out of a Pile error body (`{ error: { message } }`). */
export function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.length > 0) {
    return body;
  }
  if (!isRecord(body)) {
    return fallback;
  }
  const nested = body.error;
  if (isRecord(nested) && typeof nested.message === "string") {
    return nested.message;
  }
  if (typeof nested === "string" && nested.length > 0) {
    return nested;
  }
  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  return fallback;
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

function errorDetails(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const details = body.details;
  return isRecord(details) ? details : undefined;
}

/** PILE-412 — the stage gate's 409 carries details.blockingSubSteps; render
 *  it as a readable list ("ISS-1 (sourced), ISS-3 (contacted)"). Returns
 *  undefined when the error isn't a stage-gate block. */
export function stageGateBlockMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const steps = error.details?.blockingSubSteps;
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const names = steps
    .map((step) => {
      if (!isRecord(step)) return null;
      const label = step.identifier ?? step.id;
      return step.stepKey ? `${label} (${step.stepKey})` : label;
    })
    .filter((name) => name !== null);
  if (names.length === 0) return undefined;
  return `Blocked by required sub-steps: ${names.join(", ")}`;
}

/** Resolve an openapi-fetch result to its data or throw an ApiError. */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok || error !== undefined) {
    throw new ApiError(
      errorMessage(error, `Request failed (${response.status})`),
      response.status,
      errorDetails(error)
    );
  }
  return data as T;
}

/** For 204 responses, where openapi-fetch yields no data. */
export async function unwrapEmpty(
  promise: Promise<FetchResult<unknown>>
): Promise<void> {
  const { error, response } = await promise;
  if (!response.ok || error !== undefined) {
    throw new ApiError(
      errorMessage(error, `Request failed (${response.status})`),
      response.status
    );
  }
}

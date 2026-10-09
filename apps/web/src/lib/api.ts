import createClient from "openapi-fetch";

import type { paths } from "../../../../packages/cli/src/client/types";

export type { paths };

// Local dev convenience: VITE_PILE_API_KEY (gitignored .env.local) sends the
// workspace API key as a bearer so the SPA can preview against a real API
// without going through sign-in.
const devApiKey =
  typeof import.meta.env.VITE_PILE_API_KEY === "string" &&
  import.meta.env.VITE_PILE_API_KEY.length > 0
    ? import.meta.env.VITE_PILE_API_KEY
    : undefined;

export const api = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "include",
  headers: devApiKey ? { Authorization: `Bearer ${devApiKey}` } : undefined,
});

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

/** Resolve an openapi-fetch result to its data or throw an ApiError. */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok || error !== undefined) {
    throw new ApiError(
      errorMessage(error, `Request failed (${response.status})`),
      response.status
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

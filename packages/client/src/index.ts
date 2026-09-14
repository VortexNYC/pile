import type { Client, ClientOptions } from "openapi-fetch";
import createClient from "openapi-fetch";

import type { paths } from "./types.js";

export type { paths };

export type PileClient = Client<paths>;

export type PileCredentials = "include" | "omit" | "same-origin";

export type PileAuth =
  | { type: "apiKey"; apiKey: string }
  | { type: "session"; cookie: string }
  | { type: "browser"; credentials?: PileCredentials };

export interface PileRetryOptions {
  maxRetries?: number;
  retryOnStatus?: readonly number[];
  retryMethods?: readonly string[];
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PileClientOptions {
  baseUrl: string;
  apiKey?: string;
  auth?: PileAuth;
  retry?: PileRetryOptions | false;
  fetch?: ClientOptions["fetch"];
  Request?: ClientOptions["Request"];
}

export const PILE_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
  "AGENT_ERROR",
  "CONFIG_ERROR",
  "INTERNAL_ERROR",
] as const;

export type PileErrorCode = (typeof PILE_ERROR_CODES)[number];

export interface PileApiError {
  kind: "api";
  code: PileErrorCode;
  status: number;
  message: string;
  hint?: string;
}

export interface PileHttpError {
  kind: "http";
  status: number;
  message: string;
  body: unknown;
}

export interface PileNetworkError {
  kind: "network";
  message: string;
  cause: unknown;
}

export type PileError = PileApiError | PileHttpError | PileNetworkError;

export class PileRequestError extends Error {
  readonly error: PileError;

  constructor(error: PileError) {
    super(error.message);
    this.name = "PileRequestError";
    this.error = error;
  }
}

const DEFAULT_RETRY: Required<Omit<PileRetryOptions, "sleep">> = {
  maxRetries: 2,
  retryOnStatus: [408, 425, 429, 500, 502, 503, 504],
  retryMethods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

function isPileErrorCode(value: unknown): value is PileErrorCode {
  return (
    typeof value === "string" &&
    (PILE_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toPileError(error: unknown, response?: Response): PileError {
  const status = response?.status ?? 0;
  if (isRecord(error)) {
    const code = error.code ?? response?.headers.get("X-Pile-Error-Code");
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.error === "string"
          ? error.error
          : response?.statusText || `Request failed with status ${status}`;
    if (isPileErrorCode(code)) {
      return {
        kind: "api",
        code,
        status,
        message,
        ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
      };
    }
    return { kind: "http", status, message, body: error };
  }
  if (response) {
    return {
      kind: "http",
      status,
      message:
        typeof error === "string" && error
          ? error
          : response.statusText || `Request failed with status ${status}`,
      body: error,
    };
  }
  return {
    kind: "network",
    message: error instanceof Error ? error.message : "Network request failed",
    cause: error,
  };
}

export function isPileErrorCodeOf<C extends PileErrorCode>(
  error: PileError,
  code: C
): error is PileApiError & { code: C } {
  return error.kind === "api" && error.code === code;
}

export async function unwrap<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>
): Promise<T> {
  const { data, error, response } = await result;
  if (error !== undefined || !response.ok) {
    throw new PileRequestError(toPileError(error, response));
  }
  return data as T;
}

function resolveAuth(options: PileClientOptions): {
  headers: Record<string, string>;
  credentials?: PileCredentials;
} {
  const auth: PileAuth | undefined =
    options.auth ??
    (options.apiKey !== undefined
      ? { type: "apiKey", apiKey: options.apiKey }
      : undefined);
  if (!auth) {
    throw new Error("createPileClient requires `apiKey` or `auth`");
  }
  switch (auth.type) {
    case "apiKey":
      return { headers: { Authorization: `Bearer ${auth.apiKey}` } };
    case "session":
      return { headers: { Cookie: auth.cookie } };
    case "browser":
      return { headers: {}, credentials: auth.credentials ?? "include" };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function withRetry(
  baseFetch: (request: Request) => Promise<Response>,
  retry: PileRetryOptions
): (request: Request) => Promise<Response> {
  const config = { ...DEFAULT_RETRY, ...retry };
  const sleep = retry.sleep ?? defaultSleep;
  const methods = new Set(
    config.retryMethods.map((method) => method.toUpperCase())
  );
  const statuses = new Set(config.retryOnStatus);

  const backoff = (attempt: number, response?: Response): number => {
    const hinted = response ? retryAfterMs(response) : undefined;
    const exponential = Math.min(
      config.maxDelayMs,
      config.baseDelayMs * 2 ** attempt
    );
    return Math.min(config.maxDelayMs, hinted ?? exponential);
  };

  const attempt = async (request: Request, n: number): Promise<Response> => {
    const last = n >= config.maxRetries;
    const attemptRequest = last ? request : request.clone();
    let response: Response;
    try {
      response = await baseFetch(attemptRequest);
    } catch (error) {
      if (last) throw error;
      await sleep(backoff(n));
      return attempt(request, n + 1);
    }
    if (last || !statuses.has(response.status)) {
      return response;
    }
    await sleep(backoff(n, response));
    return attempt(request, n + 1);
  };

  return (request) =>
    methods.has(request.method.toUpperCase())
      ? attempt(request, 0)
      : baseFetch(request);
}

export function createPileClient(options: PileClientOptions): PileClient {
  const { headers, credentials } = resolveAuth(options);
  const baseFetch: (request: Request) => Promise<Response> =
    options.fetch ?? ((request) => fetch(request));
  const fetchImpl =
    options.retry === false
      ? baseFetch
      : withRetry(baseFetch, options.retry ?? {});

  return createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/$/u, ""),
    headers,
    ...(credentials ? { credentials } : {}),
    fetch: fetchImpl,
    Request: options.Request,
  });
}

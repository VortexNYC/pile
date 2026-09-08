import type { createSlackAdapter } from "@chat-adapter/slack";

/**
 * Slack's `WebClient` uses axios, whose fetch adapter sends `cache: "default"`
 * in every Request init. workerd's fetch rejects that cache mode, so every
 * Slack API call from a Worker spins in axios's retry loop forever.
 *
 * `WebClientOptions.adapter` is the provider-supported escape hatch: it is an
 * axios adapter slot. This adapter reimplements just enough of the axios
 * contract on top of plain `fetch` (no `cache` option) so the WebClient works
 * on Cloudflare Workers.
 */

type SlackAdapterConfig = Parameters<typeof createSlackAdapter>[0];
type WebClientOptions = NonNullable<
  NonNullable<SlackAdapterConfig>["webClientOptions"]
>;
type AxiosAdapter = NonNullable<WebClientOptions["adapter"]>;
type AdapterConfig = Parameters<AxiosAdapter>[0];
type AdapterResponse = Awaited<ReturnType<AxiosAdapter>>;
type AdapterRequest = AdapterResponse["request"];

type HeaderValue = string | string[] | number | boolean | null | undefined;

function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const read = (input: Record<string, HeaderValue>) => {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null || v === false) continue;
      out[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  };
  if (headers instanceof Headers) {
    for (const [k, v] of headers.entries()) out[k] = v;
  } else if (
    headers !== null &&
    typeof headers === "object" &&
    "toJSON" in headers &&
    typeof (headers as { toJSON: () => unknown }).toJSON === "function"
  ) {
    const json = (headers as { toJSON: () => unknown }).toJSON();
    if (json !== null && typeof json === "object" && !Array.isArray(json)) {
      read(json as Record<string, HeaderValue>);
    }
  } else if (
    headers !== null &&
    typeof headers === "object" &&
    !Array.isArray(headers)
  ) {
    read(headers as Record<string, HeaderValue>);
  }
  return out;
}

function isBodyInit(data: unknown): data is BodyInit {
  return (
    typeof data === "string" ||
    data instanceof URLSearchParams ||
    data instanceof FormData ||
    data instanceof Blob ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data)
  );
}

export class SlackFetchAdapterError extends Error {
  readonly isAxiosError = true;
  readonly request: AdapterRequest;
  readonly config: AdapterConfig;
  readonly response?: AdapterResponse;

  constructor(
    message: string,
    readonly code: string,
    config: AdapterConfig,
    request: AdapterRequest,
    response?: AdapterResponse
  ) {
    super(message);
    this.name = "AxiosError";
    this.config = config;
    this.request = request;
    this.response = response;
  }

  toJSON(): Record<string, unknown> {
    return {
      message: this.message,
      name: this.name,
      code: this.code,
      status: this.response?.status ?? null,
      config: {
        url: this.config.url,
        method: this.config.method,
      },
    };
  }
}

function appendParams(url: URL, params: unknown): void {
  if (params === null || typeof params !== "object") return;
  for (const [key, value] of Object.entries(
    params as Record<string, unknown>
  )) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
}

export const workerdFetchAdapter: AxiosAdapter = async (config) => {
  const baseURL = config.baseURL ?? "https://slack.com/api/";
  const url = new URL(config.url ?? "", baseURL);
  appendParams(url, config.params);

  const headers = new Headers(headersToRecord(config.headers));

  let body: BodyInit | null = null;
  if (config.data !== undefined && config.data !== null) {
    if (isBodyInit(config.data)) {
      body = config.data;
    } else {
      body = JSON.stringify(config.data);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const signals: AbortSignal[] = [];
  const external = config.signal;
  if (external) {
    if (external instanceof AbortSignal) {
      signals.push(external);
    } else {
      const controller = new AbortController();
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener?.("abort", () => controller.abort());
      }
      signals.push(controller.signal);
    }
  }
  if (config.timeout && config.timeout > 0) {
    signals.push(AbortSignal.timeout(config.timeout));
  }
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  const request = new Request(url.toString(), {
    method: (config.method ?? "get").toUpperCase(),
    headers,
    body,
    signal,
    redirect: "follow",
  });

  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    const isAbort =
      error instanceof DOMException && error.name === "AbortError";
    const isTimeout =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SlackFetchAdapterError(
      isTimeout
        ? (config.timeoutErrorMessage ??
            `timeout of ${config.timeout}ms exceeded`)
        : error instanceof Error
          ? error.message
          : "Network Error",
      isTimeout ? "ECONNABORTED" : isAbort ? "ERR_CANCELED" : "ERR_NETWORK",
      config,
      request
    );
  }

  const responseType = config.responseType ?? "json";
  let data: unknown;
  if (responseType === "arraybuffer") {
    data = await response.arrayBuffer();
  } else if (responseType === "blob") {
    data = await response.blob();
  } else if (responseType === "stream") {
    data = await response.text();
  } else {
    const text = await response.text();
    data =
      responseType === "json" && text.length > 0
        ? (() => {
            try {
              return JSON.parse(text) as unknown;
            } catch {
              return text;
            }
          })()
        : text;
  }

  const result: AdapterResponse = {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    config,
    request,
  };

  const validateStatus =
    config.validateStatus ??
    ((status: number) => status >= 200 && status < 300);
  if (!validateStatus(response.status)) {
    throw new SlackFetchAdapterError(
      `Request failed with status code ${response.status}`,
      `ERR_BAD_${response.status >= 500 ? "RESPONSE" : "REQUEST"}`,
      config,
      request,
      result
    );
  }
  return result;
};

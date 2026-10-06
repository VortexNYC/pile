import {
  MAX_BODY_LENGTH,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
} from "../constants.js";
import type { DebuggerEvent } from "../types.js";
import type { EventRecorder } from "./recorder.js";
import {
  createNonFatalReporter,
  getElementTarget,
  getRequestBodyPreviewAsync,
  getTextBodyPreviewAsync,
  parseRawHeaders,
  redactSensitiveQueryParams,
  sanitizeCapturedBody,
  scheduleBackgroundTask,
  shouldCaptureTextContent,
  shouldHideHeader,
  toAbsoluteUrl,
  toHeaderRecord,
  truncate,
  type Reporter,
} from "./sanitize.js";
import { createStringifyValue } from "./serializer.js";

export interface Instrumentation {
  dispose(): void;
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** DevTools-grade timing phases via PerformanceResourceTiming. */
function getResourceTiming(
  url: string,
  startedAt: number
): import("../types.js").DebuggerNetworkTiming | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  try {
    const entries = performance.getEntriesByName(
      url
    ) as PerformanceResourceTiming[];
    const entry = entries
      .filter((e) => e.startTime <= Date.now() - performance.timeOrigin + 100)
      .toSorted((a, b) => b.startTime - a.startTime)
      .find((e) => e.startTime >= startedAt - performance.timeOrigin - 500);
    if (!entry) {
      return undefined;
    }
    const timing: import("../types.js").DebuggerNetworkTiming = {};
    if (entry.domainLookupEnd > entry.domainLookupStart) {
      timing.dns = Math.round(entry.domainLookupEnd - entry.domainLookupStart);
    }
    if (entry.connectEnd > entry.connectStart) {
      const secure = entry.secureConnectionStart > 0;
      timing.connect = Math.round(
        (secure ? entry.secureConnectionStart : entry.connectEnd) -
          entry.connectStart
      );
      if (secure) {
        timing.tls = Math.round(entry.connectEnd - entry.secureConnectionStart);
      }
    }
    if (entry.responseStart > 0 && entry.requestStart > 0) {
      timing.ttfb = Math.round(entry.responseStart - entry.requestStart);
    }
    if (entry.responseEnd > entry.responseStart) {
      timing.download = Math.round(entry.responseEnd - entry.responseStart);
    }
    return Object.keys(timing).length > 0 ? timing : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GraphQL detection (Jam parity): operation name/type from the request body
 * plus errors-in-200 flagging from the response body.
 */
function detectGraphql(
  url: string,
  requestBody: string | undefined,
  responseBody: string | undefined
): import("../types.js").DebuggerGraphqlInfo | undefined {
  let operationName: string | undefined;
  let operationType: "query" | "mutation" | "subscription" | undefined;
  try {
    const parsed = requestBody ? JSON.parse(requestBody) : null;
    const payload = Array.isArray(parsed) ? parsed[0] : parsed;
    if (payload && typeof payload === "object") {
      const body = payload as Record<string, unknown>;
      if (typeof body.operationName === "string" && body.operationName) {
        operationName = body.operationName;
      }
      if (typeof body.query === "string") {
        const match = body.query.match(/^\s*(query|mutation|subscription)/);
        operationType = (match?.[1] ?? "query") as typeof operationType;
      }
    }
  } catch {
    // Not JSON — check URL fallback below.
  }
  const looksGraphql =
    operationName !== undefined ||
    operationType !== undefined ||
    /graphql/i.test(url);
  if (!looksGraphql) {
    return undefined;
  }
  const info: import("../types.js").DebuggerGraphqlInfo = {
    operationName,
    operationType,
  };
  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody) as Record<string, unknown>;
      if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
        info.hasErrors = true;
      }
    } catch {
      // Non-JSON response — leave flag unset.
    }
  }
  return info;
}

/** Jam-style binary placeholder from the content-length header. */
function binaryPlaceholder(
  responseHeaders: Record<string, string>
): string | undefined {
  const length = Number(responseHeaders["content-length"]);
  return Number.isFinite(length) && length > 0
    ? `[binary: ${length} bytes]`
    : undefined;
}

export function installInstrumentation(
  recorder: EventRecorder,
  options: { networkBodies: boolean; excludeUrlPrefixes?: string[] }
): Instrumentation {
  const reporter = createNonFatalReporter();
  const stringifyValue = createStringifyValue(reporter);
  const restores: Array<() => void> = [];
  const excludeUrlPrefixes = options.excludeUrlPrefixes ?? [];
  const isExcluded = (url: string) =>
    excludeUrlPrefixes.some((prefix) => url.startsWith(prefix));

  restores.push(installConsole(recorder, reporter, stringifyValue));
  restores.push(installErrors(recorder, reporter));
  restores.push(installActions(recorder, reporter));
  restores.push(installWebSocket(recorder, reporter, isExcluded));
  if (options.networkBodies) {
    restores.push(
      installNetwork(recorder, reporter, stringifyValue, isExcluded)
    );
  } else {
    restores.push(installNetworkShallow(recorder, reporter, isExcluded));
  }

  return {
    dispose() {
      for (const restore of restores.splice(0)) {
        try {
          restore();
        } catch (error) {
          reporter.reportNonFatalError(
            "Failed to restore instrumentation",
            error
          );
        }
      }
    },
  };
}

function installConsole(
  recorder: EventRecorder,
  reporter: Reporter,
  stringifyValue: (value: unknown) => string
): () => void {
  if (typeof console === "undefined") {
    return () => {};
  }
  const originals: Array<() => void> = [];
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        const serializedArgs = args.map(stringifyValue);
        recorder.push({
          kind: "console",
          timestamp: Date.now(),
          level,
          message: truncate(serializedArgs.join(" ")),
          metadata: { argumentCount: args.length },
        });
      } catch (error) {
        reporter.reportNonFatalError("Failed to record console event", error);
      }
      original(...args);
    };
    originals.push(() => {
      console[level] = original;
    });
  }
  return () => {
    for (const restore of originals) restore();
  };
}

function installErrors(
  recorder: EventRecorder,
  reporter: Reporter
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onError = (event: ErrorEvent) => {
    recorder.push({
      kind: "error",
      timestamp: Date.now(),
      message: event.message || "Uncaught error",
      stack:
        event.error instanceof Error
          ? (event.error.stack ?? undefined)
          : undefined,
      source: "exception",
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    recorder.push({
      kind: "error",
      timestamp: Date.now(),
      message:
        reason instanceof Error
          ? reason.message
          : String(reason ?? "Unhandled rejection"),
      stack: reason instanceof Error ? (reason.stack ?? undefined) : undefined,
      source: "unhandledrejection",
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    void reporter;
  };
}

function installActions(
  recorder: EventRecorder,
  reporter: Reporter
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const postAction = (
    actionType: string,
    target: string | undefined,
    metadata?: Record<string, unknown>
  ) => {
    recorder.push({
      kind: "action",
      timestamp: Date.now(),
      actionType,
      target,
      metadata,
    });
  };
  const postNavigation = (mode: string) => {
    postAction("navigation", "window", {
      mode,
      url: location.href,
      path: location.pathname,
      search: location.search,
      hash: location.hash,
      title: document.title,
    });
  };

  const delegated = (event: Event) => {
    try {
      if (event.type === "click") {
        postAction("click", getElementTarget(event.target));
        return;
      }
      if (event.type === "input") {
        const target = event.target;
        const valueLength =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
            ? target.value.length
            : undefined;
        postAction("input", getElementTarget(target), { valueLength });
        return;
      }
      if (event.type === "change") {
        postAction("change", getElementTarget(event.target));
        return;
      }
      if (event.type === "submit") {
        postAction("submit", getElementTarget(event.target));
      }
    } catch (error) {
      reporter.reportNonFatalError("Failed to record action event", error);
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === "Escape") {
      postAction("keydown", getElementTarget(event.target), { key: event.key });
    }
  };

  for (const type of ["click", "input", "change", "submit"] as const) {
    document.addEventListener(type, delegated, {
      capture: true,
      passive: true,
    });
  }
  document.addEventListener("keydown", onKeydown, {
    capture: true,
    passive: true,
  });

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    postNavigation("pushState");
  };
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    postNavigation("replaceState");
  };
  const onPopstate = () => postNavigation("popstate");
  const onHashchange = () => postNavigation("hashchange");
  window.addEventListener("popstate", onPopstate, {
    capture: true,
    passive: true,
  });
  window.addEventListener("hashchange", onHashchange, {
    capture: true,
    passive: true,
  });

  postNavigation("initial");

  return () => {
    for (const type of ["click", "input", "change", "submit"] as const) {
      document.removeEventListener(type, delegated, { capture: true });
    }
    document.removeEventListener("keydown", onKeydown, { capture: true });
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", onPopstate, { capture: true });
    window.removeEventListener("hashchange", onHashchange, { capture: true });
  };
}

interface FetchContext {
  method: string;
  normalizedUrl: string;
  requestHeaders: Record<string, string>;
  requestContentType: string;
  requestBodyPromise: Promise<string | undefined>;
}

function resolveFetchContext(
  args: Parameters<typeof fetch>,
  reporter: Reporter,
  stringifyValue: (value: unknown) => string,
  requestBodyByRequest: WeakMap<Request, Promise<string | undefined>>
): FetchContext | null {
  const [requestInput, requestInit] = args;
  const method = (
    requestInit?.method ??
    (requestInput instanceof Request ? requestInput.method : "GET")
  ).toUpperCase();
  const url =
    typeof requestInput === "string"
      ? requestInput
      : requestInput instanceof URL
        ? requestInput.toString()
        : requestInput.url;
  const absoluteUrl = toAbsoluteUrl(url, reporter);
  if (!absoluteUrl) {
    return null;
  }

  let requestHeaderSource: Headers | null = null;
  if (requestInit?.headers) {
    try {
      requestHeaderSource = new Headers(requestInit.headers);
    } catch (error) {
      reporter.reportNonFatalError("Failed to normalize fetch headers", error);
    }
  } else if (requestInput instanceof Request) {
    requestHeaderSource = requestInput.headers;
  }

  const requestHeaders = requestHeaderSource
    ? toHeaderRecord(requestHeaderSource)
    : {};
  const requestContentType = requestHeaderSource?.get("content-type") ?? "";

  const requestBodyPromise = (() => {
    if (requestInput instanceof Request) {
      const cached = requestBodyByRequest.get(requestInput);
      if (cached) {
        return cached;
      }
    }
    const initPreview = requestInit?.body;
    if (initPreview !== undefined && initPreview !== null) {
      return getRequestBodyPreviewAsync(
        reporter,
        initPreview,
        stringifyValue,
        requestContentType
      );
    }
    if (requestInput instanceof Request) {
      if (method === "GET" || method === "HEAD" || requestInput.bodyUsed) {
        return Promise.resolve(undefined);
      }
      return getTextBodyPreviewAsync(
        reporter,
        requestContentType || requestInput.headers.get("content-type") || "",
        "Failed to capture fetch request body",
        () => requestInput.clone().text()
      );
    }
    return Promise.resolve(undefined);
  })();

  return {
    method,
    normalizedUrl: redactSensitiveQueryParams(absoluteUrl),
    requestHeaders,
    requestContentType,
    requestBodyPromise,
  };
}

function installRequestConstructorCapture(
  reporter: Reporter,
  stringifyValue: (value: unknown) => string,
  requestBodyByRequest: WeakMap<Request, Promise<string | undefined>>
): () => void {
  if (typeof Request !== "function") {
    return () => {};
  }
  const OriginalRequest = Request;
  const patchedRequest = new Proxy(OriginalRequest, {
    construct(target, argArray, newTarget) {
      const [, requestInit] = argArray as [
        RequestInfo | URL,
        RequestInit | undefined,
      ];
      const requestInstance = Reflect.construct(
        target,
        argArray,
        newTarget
      ) as Request;
      let requestHeaderSource: Headers;
      if (requestInit?.headers !== undefined) {
        try {
          requestHeaderSource = new Headers(requestInit.headers);
        } catch (error) {
          reporter.reportNonFatalError(
            "Failed to normalize Request headers",
            error
          );
          requestHeaderSource = requestInstance.headers;
        }
      } else {
        requestHeaderSource = requestInstance.headers;
      }
      const contentType = requestHeaderSource.get("content-type") ?? "";
      const bodyPromise =
        requestInit?.body !== undefined
          ? getRequestBodyPreviewAsync(
              reporter,
              requestInit.body,
              stringifyValue,
              contentType
            )
          : getTextBodyPreviewAsync(
              reporter,
              contentType,
              "Failed to capture Request body text",
              () =>
                requestInstance.bodyUsed
                  ? Promise.resolve("")
                  : requestInstance.clone().text()
            );
      requestBodyByRequest.set(requestInstance, bodyPromise);
      return requestInstance;
    },
  });
  try {
    Object.assign(patchedRequest, OriginalRequest);
  } catch (error) {
    reporter.reportNonFatalError("Failed to mirror Request properties", error);
  }
  try {
    (globalThis as { Request?: typeof Request }).Request =
      patchedRequest as typeof Request;
  } catch (error) {
    reporter.reportNonFatalError("Failed to patch Request constructor", error);
  }
  return () => {
    (globalThis as { Request?: typeof Request }).Request = OriginalRequest;
  };
}

function postNetworkEvent(
  recorder: EventRecorder,
  payload: Omit<
    Extract<DebuggerEvent, { kind: "network" }>,
    "kind" | "timestamp"
  >
) {
  recorder.push({ kind: "network", timestamp: Date.now(), ...payload });
}

function installFetch(
  recorder: EventRecorder,
  reporter: Reporter,
  stringifyValue: (value: unknown) => string,
  isExcluded: (url: string) => boolean
): () => void {
  if (typeof globalThis.fetch !== "function") {
    return () => {};
  }
  const requestBodyByRequest = new WeakMap<
    Request,
    Promise<string | undefined>
  >();
  const restoreRequest = installRequestConstructorCapture(
    reporter,
    stringifyValue,
    requestBodyByRequest
  );

  const baseFetch = globalThis.fetch.bind(globalThis);
  let delegateFetch = baseFetch;
  let isInsidePatchedFetch = false;

  const patchedFetch = (async (...args: Parameters<typeof fetch>) => {
    // Re-entry guard: only needed when another library re-wrapped fetch (the
    // accessor setter pointed delegateFetch at their wrapper, which calls
    // globalThis.fetch → patchedFetch → their wrapper → loop). With the raw
    // baseFetch there is no loop, so concurrent in-flight fetches must not
    // bypass instrumentation.
    if (isInsidePatchedFetch && delegateFetch !== baseFetch) {
      return baseFetch(...args);
    }
    isInsidePatchedFetch = true;
    const startedAt = Date.now();
    const context = resolveFetchContext(
      args,
      reporter,
      stringifyValue,
      requestBodyByRequest
    );
    if (!context || isExcluded(context.normalizedUrl)) {
      try {
        return await delegateFetch(...args);
      } finally {
        isInsidePatchedFetch = false;
      }
    }
    try {
      const response = await delegateFetch(...args);
      const duration = Date.now() - startedAt;
      const responseHeaders = toHeaderRecord(response.headers);
      const contentType = response.headers.get("content-type") ?? "";
      let responseClone: Response | null = null;
      if (shouldCaptureTextContent(contentType) && !response.bodyUsed) {
        try {
          responseClone = response.clone();
        } catch (error) {
          reporter.reportNonFatalError("Failed to clone fetch response", error);
        }
      }
      scheduleBackgroundTask(reporter, async () => {
        let requestBody: string | undefined;
        let responseBody: string | undefined;
        try {
          requestBody = await context.requestBodyPromise;
        } catch (error) {
          reporter.reportNonFatalError(
            "Failed to resolve fetch request body",
            error
          );
        }
        try {
          if (responseClone) {
            responseBody = await getTextBodyPreviewAsync(
              reporter,
              contentType,
              "Failed to capture fetch response body",
              () => responseClone.text()
            );
          }
        } catch (error) {
          reporter.reportNonFatalError(
            "Failed to capture fetch response body",
            error
          );
        }
        const sanitizedResponseBody = sanitizeCapturedBody(
          responseBody ?? binaryPlaceholder(responseHeaders),
          contentType
        );
        postNetworkEvent(recorder, {
          method: context.method,
          url: context.normalizedUrl,
          status: response.status,
          duration,
          requestHeaders: context.requestHeaders,
          responseHeaders,
          requestBody: sanitizeCapturedBody(
            requestBody,
            context.requestContentType
          ),
          responseBody: sanitizedResponseBody,
          timing: getResourceTiming(context.normalizedUrl, startedAt),
          graphql: detectGraphql(
            context.normalizedUrl,
            requestBody,
            responseBody
          ),
        });
      });
      return response;
    } catch (error) {
      scheduleBackgroundTask(reporter, async () => {
        let requestBody: string | undefined;
        try {
          requestBody = await context.requestBodyPromise;
        } catch {
          requestBody = undefined;
        }
        postNetworkEvent(recorder, {
          method: context.method,
          url: context.normalizedUrl,
          status: 0,
          duration: Date.now() - startedAt,
          requestHeaders: context.requestHeaders,
          requestBody: sanitizeCapturedBody(
            requestBody,
            context.requestContentType
          ),
          responseBody: sanitizeCapturedBody(
            truncate(stringifyValue(error), MAX_BODY_LENGTH),
            ""
          ),
        });
      });
      throw error;
    } finally {
      isInsidePatchedFetch = false;
    }
  }) as typeof fetch;

  try {
    Object.assign(patchedFetch, globalThis.fetch);
  } catch (error) {
    reporter.reportNonFatalError("Failed to mirror fetch properties", error);
  }

  const fetchTarget = globalThis as { fetch?: typeof fetch };
  const descriptor = Object.getOwnPropertyDescriptor(fetchTarget, "fetch");
  const canRedefine = !descriptor || descriptor.configurable;
  let usedAccessor = false;

  if (canRedefine) {
    try {
      Object.defineProperty(fetchTarget, "fetch", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return patchedFetch;
        },
        set(nextFetch: unknown) {
          if (typeof nextFetch !== "function" || nextFetch === patchedFetch) {
            return;
          }
          delegateFetch = (nextFetch as typeof fetch).bind(globalThis);
        },
      });
      usedAccessor = true;
    } catch (error) {
      reporter.reportNonFatalError("Failed to install fetch accessor", error);
    }
  }
  if (!usedAccessor) {
    try {
      fetchTarget.fetch = patchedFetch;
    } catch (error) {
      reporter.reportNonFatalError("Failed to patch fetch", error);
    }
  }

  return () => {
    restoreRequest();
    try {
      if (usedAccessor) {
        Object.defineProperty(fetchTarget, "fetch", {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          writable: true,
          value: baseFetch,
        });
      } else {
        fetchTarget.fetch = baseFetch;
      }
    } catch (error) {
      reporter.reportNonFatalError("Failed to restore fetch", error);
    }
  };
}

function installXhr(
  recorder: EventRecorder,
  reporter: Reporter,
  stringifyValue: (value: unknown) => string,
  isExcluded: (url: string) => boolean
): () => void {
  if (typeof XMLHttpRequest === "undefined") {
    return () => {};
  }
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;

  type XhrMeta = {
    method: string;
    url: string;
    startedAt: number;
    requestBodyPromise: Promise<string | undefined>;
    requestHeaders: Record<string, string>;
  };
  const xhrMetaMap = new WeakMap<XMLHttpRequest, XhrMeta>();

  const buildPayload = async (xhr: XMLHttpRequest) => {
    const meta = xhrMetaMap.get(xhr);
    if (!meta) {
      return null;
    }
    const absoluteUrl = toAbsoluteUrl(meta.url, reporter);
    if (!absoluteUrl || isExcluded(absoluteUrl)) {
      return null;
    }
    let requestBody: string | undefined;
    let responseBody: string | undefined;
    const responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
    const responseContentType = responseHeaders["content-type"] ?? "";
    try {
      requestBody = await meta.requestBodyPromise;
    } catch {
      requestBody = undefined;
    }
    try {
      if (xhr.responseType === "" || xhr.responseType === "text") {
        responseBody = truncate(xhr.responseText || "", MAX_BODY_LENGTH);
      } else if (xhr.responseType === "json") {
        responseBody = truncate(stringifyValue(xhr.response), MAX_BODY_LENGTH);
      }
    } catch (error) {
      reporter.reportNonFatalError(
        "Failed to capture XHR response body",
        error
      );
    }
    const normalizedUrl = redactSensitiveQueryParams(absoluteUrl);
    return {
      method: meta.method,
      url: normalizedUrl,
      status: xhr.status,
      duration: Date.now() - meta.startedAt,
      requestHeaders: meta.requestHeaders,
      responseHeaders,
      requestBody: sanitizeCapturedBody(
        requestBody,
        meta.requestHeaders["content-type"] ?? ""
      ),
      responseBody: sanitizeCapturedBody(
        responseBody ??
          (xhr.responseType === "arraybuffer" || xhr.responseType === "blob"
            ? `[binary: ${
                xhr.response instanceof ArrayBuffer
                  ? xhr.response.byteLength
                  : xhr.response instanceof Blob
                    ? xhr.response.size
                    : 0
              } bytes]`
            : binaryPlaceholder(responseHeaders)),
        responseContentType
      ),
      timing: getResourceTiming(normalizedUrl, meta.startedAt),
      graphql: detectGraphql(normalizedUrl, requestBody, responseBody),
    };
  };

  const openWithOptionalArgs = originalOpen as unknown as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) => void;

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    xhrMetaMap.set(this, {
      method: typeof method === "string" ? method : "GET",
      url: typeof url === "string" ? url : String(url ?? ""),
      startedAt: Date.now(),
      requestBodyPromise: Promise.resolve(undefined),
      requestHeaders: {},
    });
    return openWithOptionalArgs.call(
      this,
      method,
      url,
      async ?? true,
      username,
      password
    );
  };

  proto.setRequestHeader = function (
    this: XMLHttpRequest,
    ...args: Parameters<typeof originalSetRequestHeader>
  ) {
    const [key, value] = args;
    const meta = xhrMetaMap.get(this);
    if (meta) {
      const normalizedKey = key.trim().toLowerCase();
      if (!shouldHideHeader(normalizedKey)) {
        meta.requestHeaders[normalizedKey.slice(0, MAX_HEADER_NAME_LENGTH)] =
          value.slice(0, MAX_HEADER_VALUE_LENGTH);
      }
    }
    return originalSetRequestHeader.apply(this, args);
  };

  proto.send = function (
    this: XMLHttpRequest,
    ...args: Parameters<typeof originalSend>
  ) {
    const meta = xhrMetaMap.get(this);
    if (meta) {
      meta.startedAt = Date.now();
      meta.requestBodyPromise = getRequestBodyPreviewAsync(
        reporter,
        args[0],
        stringifyValue,
        meta.requestHeaders["content-type"] ?? ""
      );
      this.addEventListener(
        "loadend",
        () => {
          scheduleBackgroundTask(reporter, async () => {
            const payload = await buildPayload(this);
            if (payload) {
              postNetworkEvent(recorder, payload);
            }
          });
        },
        { once: true }
      );
    }
    return originalSend.apply(this, args);
  };

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.setRequestHeader = originalSetRequestHeader;
  };
}

function installNetwork(
  recorder: EventRecorder,
  reporter: Reporter,
  stringifyValue: (value: unknown) => string,
  isExcluded: (url: string) => boolean
): () => void {
  const restoreFetch = installFetch(
    recorder,
    reporter,
    stringifyValue,
    isExcluded
  );
  const restoreXhr = installXhr(recorder, reporter, stringifyValue, isExcluded);
  return () => {
    restoreFetch();
    restoreXhr();
  };
}

const MAX_WS_PREVIEW = 500;

const describeData = (data: unknown): Record<string, unknown> => {
  if (typeof data === "string") {
    return {
      payloadLength: data.length,
      preview: truncate(data, MAX_WS_PREVIEW),
    };
  }
  if (data instanceof ArrayBuffer) {
    return { payloadLength: data.byteLength, binary: true };
  }
  if (ArrayBuffer.isView(data)) {
    return { payloadLength: data.byteLength, binary: true };
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { payloadLength: data.size, binary: true };
  }
  return {};
};

/**
 * WebSocket capture (Jam parity): open/close/send/message as action events.
 * Text frames get a truncated sanitized preview; binary frames record
 * length only.
 */
function installWebSocket(
  recorder: EventRecorder,
  reporter: Reporter,
  isExcluded: (url: string) => boolean
): () => void {
  const NativeWebSocket = (globalThis as { WebSocket?: typeof WebSocket })
    .WebSocket;
  if (typeof NativeWebSocket !== "function") {
    return () => {};
  }

  const post = (
    url: string,
    event: string,
    extra?: Record<string, unknown>
  ) => {
    recorder.push({
      kind: "action",
      timestamp: Date.now(),
      actionType: "websocket",
      target: url,
      metadata: { event, ...extra },
    });
  };

  class PatchedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const normalizedUrl = (() => {
        try {
          return redactSensitiveQueryParams(String(url));
        } catch {
          return String(url);
        }
      })();
      const excluded = isExcluded(normalizedUrl);
      if (excluded) {
        return;
      }
      post(normalizedUrl, "open");
      this.addEventListener("close", (event) => {
        post(normalizedUrl, "close", { code: event.code });
      });
      this.addEventListener("message", (event) => {
        try {
          post(normalizedUrl, "message", describeData(event.data));
        } catch (error) {
          reporter.reportNonFatalError(
            "Failed to record websocket message",
            error
          );
        }
      });
    }

    override send(data: string | Blob | BufferSource) {
      const normalizedUrl = (() => {
        try {
          return redactSensitiveQueryParams(this.url);
        } catch {
          return this.url;
        }
      })();
      if (!isExcluded(normalizedUrl)) {
        post(normalizedUrl, "send", describeData(data));
      }
      return super.send(data);
    }
  }

  try {
    Object.assign(PatchedWebSocket, NativeWebSocket);
  } catch (error) {
    reporter.reportNonFatalError(
      "Failed to mirror WebSocket properties",
      error
    );
  }
  (globalThis as { WebSocket?: typeof WebSocket }).WebSocket =
    PatchedWebSocket as typeof WebSocket;
  return () => {
    (globalThis as { WebSocket?: typeof WebSocket }).WebSocket =
      NativeWebSocket;
  };
}

/** Network capture with bodies disabled: method/url/status/duration only. */
function installNetworkShallow(
  recorder: EventRecorder,
  reporter: Reporter,
  isExcluded: (url: string) => boolean
): () => void {
  const stringifyValue = createStringifyValue(reporter);
  const noBodyRequestBodyByRequest = new WeakMap<
    Request,
    Promise<string | undefined>
  >();
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return () => {};
  }
  const shallowFetch = (async (...args: Parameters<typeof fetch>) => {
    const startedAt = Date.now();
    const [requestInput, requestInit] = args;
    const method = (
      requestInit?.method ??
      (requestInput instanceof Request ? requestInput.method : "GET")
    ).toUpperCase();
    const url =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url;
    const absoluteUrl = toAbsoluteUrl(url, reporter);
    const excluded = !absoluteUrl || isExcluded(absoluteUrl);
    try {
      const response = await originalFetch(...args);
      if (absoluteUrl && !excluded) {
        postNetworkEvent(recorder, {
          method,
          url: redactSensitiveQueryParams(absoluteUrl),
          status: response.status,
          duration: Date.now() - startedAt,
        });
      }
      return response;
    } catch (error) {
      if (absoluteUrl && !excluded) {
        postNetworkEvent(recorder, {
          method,
          url: redactSensitiveQueryParams(absoluteUrl),
          status: 0,
          duration: Date.now() - startedAt,
        });
      }
      throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = shallowFetch;
  return () => {
    globalThis.fetch = originalFetch;
    void noBodyRequestBodyByRequest;
    void stringifyValue;
  };
}

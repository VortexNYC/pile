import {
  MAX_BODY_LENGTH,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
} from "../constants";
import type { DebuggerEvent } from "../types";
import type { EventRecorder } from "./recorder";
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
} from "./sanitize";
import { createStringifyValue } from "./serializer";

export interface Instrumentation {
  dispose(): void;
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

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
    if (isInsidePatchedFetch) {
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
          responseBody: sanitizeCapturedBody(responseBody, contentType),
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
    return {
      method: meta.method,
      url: redactSensitiveQueryParams(absoluteUrl),
      status: xhr.status,
      duration: Date.now() - meta.startedAt,
      requestHeaders: meta.requestHeaders,
      responseHeaders,
      requestBody: sanitizeCapturedBody(
        requestBody,
        meta.requestHeaders["content-type"] ?? ""
      ),
      responseBody: sanitizeCapturedBody(responseBody, responseContentType),
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

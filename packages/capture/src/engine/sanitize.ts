import {
  MAX_BODY_LENGTH,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  MAX_TEXT_LENGTH,
} from "../constants.js";

export interface Reporter {
  reportNonFatalError: (context: string, error: unknown) => void;
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_NAME_PATTERNS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "session",
  "api-key",
  "apikey",
  "x-api-key",
  "refresh-token",
  "refresh_token",
  "access-token",
  "access_token",
  "id-token",
  "id_token",
  "client-secret",
  "client_secret",
] as const;

const REDACTABLE_FIELD_PATTERN =
  /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|pwd|authorization|cookie|session[_-]?id)\s*[:=]\s*)([^&\s",;]+)/gi;

export const truncate = (
  value: string,
  maxLength = MAX_TEXT_LENGTH
): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
};

export const isSensitiveName = (value: string): boolean => {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return false;
  }
  return SENSITIVE_NAME_PATTERNS.some((pattern) =>
    normalizedValue.includes(pattern)
  );
};

export const shouldHideHeader = (headerName: string): boolean => {
  return headerName.includes("debugger") || isSensitiveName(headerName);
};

export const getElementTarget = (
  target: EventTarget | null
): string | undefined => {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return undefined;
  }
  if (target.id) {
    return `#${target.id}`;
  }
  const classNames =
    typeof target.className === "string" ? target.className : "";
  const firstClass = classNames
    .split(" ")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (firstClass) {
    return `${target.tagName.toLowerCase()}.${firstClass}`;
  }
  return target.tagName.toLowerCase();
};

export const toAbsoluteUrl = (
  value: string,
  reporter: Reporter
): string | null => {
  try {
    const base =
      typeof location !== "undefined" ? location.href : "http://localhost/";
    return new URL(value, base).toString();
  } catch (error) {
    reporter.reportNonFatalError(
      "Failed to normalize network URL in capture instrumentation",
      { error, value }
    );
    return null;
  }
};

export const redactSensitiveQueryParams = (absoluteUrl: string): string => {
  try {
    const parsedUrl = new URL(absoluteUrl);
    for (const [key] of parsedUrl.searchParams.entries()) {
      if (!isSensitiveName(key)) {
        continue;
      }
      parsedUrl.searchParams.set(key, REDACTED_VALUE);
    }
    return parsedUrl.toString();
  } catch {
    return absoluteUrl;
  }
};

const sanitizeStructuredValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 6) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (isSensitiveName(key)) {
        result[key] = REDACTED_VALUE;
        continue;
      }
      result[key] = sanitizeStructuredValue(nestedValue, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") {
    return value.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`);
  }
  return value;
};

const sanitizeUrlEncodedBody = (body: string): string => {
  const params = new URLSearchParams(body);
  for (const [key] of params.entries()) {
    if (!isSensitiveName(key)) {
      continue;
    }
    params.set(key, REDACTED_VALUE);
  }
  return params.toString();
};

export const sanitizeCapturedBody = (
  body: string | undefined,
  contentType: string
): string | undefined => {
  if (typeof body !== "string" || body.length === 0) {
    return body;
  }
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      return truncate(
        JSON.stringify(sanitizeStructuredValue(parsed)),
        MAX_TEXT_LENGTH * 2
      );
    } catch {
      return truncate(
        body.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`),
        MAX_TEXT_LENGTH * 2
      );
    }
  }
  if (normalizedContentType.includes("x-www-form-urlencoded")) {
    return truncate(sanitizeUrlEncodedBody(body), MAX_TEXT_LENGTH * 2);
  }
  return truncate(
    body.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`),
    MAX_TEXT_LENGTH * 2
  );
};

export const toHeaderRecord = (
  input: Headers | null | undefined
): Record<string, string> => {
  if (!input) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of input.entries()) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || shouldHideHeader(normalizedKey)) {
      continue;
    }
    result[normalizedKey.slice(0, MAX_HEADER_NAME_LENGTH)] = value.slice(
      0,
      MAX_HEADER_VALUE_LENGTH
    );
  }
  return result;
};

export const parseRawHeaders = (rawHeaders: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of rawHeaders.split("\n")) {
    const normalizedLine = line.replace("\r", "");
    const separatorIndex = normalizedLine.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = normalizedLine.slice(0, separatorIndex).trim().toLowerCase();
    if (!key || shouldHideHeader(key)) {
      continue;
    }
    const value = normalizedLine.slice(separatorIndex + 1).trim();
    if (!value) {
      continue;
    }
    result[key.slice(0, MAX_HEADER_NAME_LENGTH)] = value.slice(
      0,
      MAX_HEADER_VALUE_LENGTH
    );
  }
  return result;
};

export const shouldCaptureTextContent = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("json") ||
    normalized.includes("text") ||
    normalized.includes("xml") ||
    normalized.includes("x-www-form-urlencoded")
  );
};

export const scheduleBackgroundTask = (
  reporter: Reporter,
  task: () => void | Promise<void>
): void => {
  const executeTask = () => {
    Promise.resolve(task()).catch((error: unknown) => {
      reporter.reportNonFatalError(
        "Background capture instrumentation task failed",
        error
      );
    });
  };
  if (
    typeof window !== "undefined" &&
    typeof window.requestIdleCallback === "function"
  ) {
    window.requestIdleCallback(() => {
      executeTask();
    });
    return;
  }
  setTimeout(executeTask, 0);
};

export const createNonFatalReporter = (): Reporter => {
  const originalWarn =
    typeof console !== "undefined" ? console.warn.bind(console) : () => {};
  const reportedContexts = new Set<string>();
  return {
    reportNonFatalError(context, error) {
      if (reportedContexts.has(context)) {
        return;
      }
      reportedContexts.add(context);
      originalWarn(`[pile-capture] ${context}`, error);
    },
  };
};

export const getRequestBodyPreview = (
  body: unknown,
  stringifyValue: (value: unknown) => string
): string | undefined => {
  if (!body) {
    return undefined;
  }
  if (typeof body === "string") {
    return truncate(body, MAX_BODY_LENGTH);
  }
  if (body instanceof URLSearchParams) {
    return truncate(body.toString(), MAX_BODY_LENGTH);
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const keys: string[] = [];
    for (const key of body.keys()) {
      keys.push(key);
    }
    return truncate(`[form-data] ${keys.join(",")}`, MAX_BODY_LENGTH);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[blob:${body.type || "unknown"}:${body.size}]`;
  }
  if (typeof ArrayBuffer !== "undefined") {
    if (body instanceof ArrayBuffer) {
      return `[arraybuffer:${body.byteLength}]`;
    }
    if (ArrayBuffer.isView(body)) {
      return `[${body.constructor.name.toLowerCase()}:${body.byteLength}]`;
    }
  }
  return truncate(stringifyValue(body), MAX_BODY_LENGTH);
};

export const getRequestBodyPreviewAsync = (
  reporter: Reporter,
  body: unknown,
  stringifyValue: (value: unknown) => string,
  contentType = ""
): Promise<string | undefined> => {
  return new Promise((resolve) => {
    scheduleBackgroundTask(reporter, () => {
      resolve(
        sanitizeCapturedBody(
          getRequestBodyPreview(body, stringifyValue),
          contentType
        )
      );
    });
  });
};

export const getTextBodyPreviewAsync = (
  reporter: Reporter,
  contentType: string,
  errorContext: string,
  readBody: () => Promise<string>
): Promise<string | undefined> => {
  return new Promise((resolve) => {
    scheduleBackgroundTask(reporter, async () => {
      if (!shouldCaptureTextContent(contentType)) {
        resolve(undefined);
        return;
      }
      try {
        resolve(
          sanitizeCapturedBody(
            truncate(await readBody(), MAX_BODY_LENGTH),
            contentType
          )
        );
      } catch (error) {
        reporter.reportNonFatalError(errorContext, error);
        resolve(undefined);
      }
    });
  });
};

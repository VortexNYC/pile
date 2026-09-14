import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import app from "../src/api/index.js";

const repoRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(repoRoot, "src/mcp/openapi.json");
const httpMethods = ["get", "post", "put", "patch", "delete"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSingular(word: string): string {
  if (word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function toDisplayWords(word: string, singularizeLast = false): string {
  const parts = word.split("-");
  if (singularizeLast && parts.length > 0) {
    parts[parts.length - 1] = toSingular(parts[parts.length - 1] ?? "");
  }
  return parts.join(" ");
}

function humanizeAction(segment: string): string {
  return segment
    .split("-")
    .map((word) =>
      word.length > 0 ? `${word[0].toUpperCase()}${word.slice(1)}` : word
    )
    .join(" ");
}

const actionSegments = new Set([
  "poll",
  "read",
  "dispatch",
  "mark-all-read",
  "unread-count",
  "install",
  "ws",
  "health",
]);

function makeSummary(method: string, path: string): string {
  const m = method.toLowerCase();

  if (path === "/health" && m === "get") return "Get health";
  if (path === "/github" && m === "post") return "Receive GitHub webhook";
  if (path === "/workspaces" && m === "get") return "List workspaces";
  if (path === "/workspaces" && m === "post") return "Create workspace";
  if (path === "/workspaces/slug/{slug}" && m === "get")
    return "Get workspace by slug";
  if (path === "/workspaces/{id}" && m === "get") return "Get workspace";
  if (path === "/workspaces/{id}" && m === "patch") return "Update workspace";
  if (path === "/workspaces/{id}" && m === "delete") return "Delete workspace";

  if (path === "/workspaces/{organizationId}/github/install" && m === "post")
    return "Install GitHub app";
  if (path === "/workspaces/{organizationId}/github/users" && m === "post")
    return "Sync GitHub users";
  if (path === "/workspaces/{organizationId}/migrate/linear" && m === "post")
    return "Migrate from Linear";
  if (path === "/workspaces/{organizationId}/ws" && m === "get")
    return "Open realtime connection";
  if (
    path === "/workspaces/{organizationId}/notifications/mark-all-read" &&
    m === "post"
  )
    return "Mark all notifications as read";
  if (
    path === "/workspaces/{organizationId}/notifications/unread-count" &&
    m === "get"
  )
    return "Get unread notification count";

  const scoped = path
    .replace(/^\/workspaces\/\{[^/]+\}\//u, "/")
    .replace(/^\/workspaces\/\{[^/]+\}$/u, "");
  const segments = scoped.split("/").filter(Boolean);

  if (segments.length === 0) {
    return `${method.toUpperCase()} ${path}`;
  }

  const last = segments[segments.length - 1];
  const secondLast =
    segments.length > 1 ? segments[segments.length - 2] : undefined;

  if (
    last !== undefined &&
    !last.startsWith("{") &&
    secondLast !== undefined &&
    secondLast.startsWith("{") &&
    actionSegments.has(last)
  ) {
    const target = segments
      .slice(0, -1)
      .filter((segment) => !segment.startsWith("{"))
      .map((segment) => toDisplayWords(segment, true))
      .join(" ");

    if (last === "read" && m === "patch") {
      return `Mark ${target} as read`;
    }

    return `${humanizeAction(last)} ${target}`.trim();
  }

  const isItem = last.startsWith("{");
  const resourceIndex = isItem ? segments.length - 2 : segments.length - 1;
  const resourceSegment = segments[resourceIndex];

  if (!resourceSegment || resourceSegment.startsWith("{")) {
    return `${method.toUpperCase()} ${path}`;
  }

  let parent: string | undefined;
  if (resourceIndex >= 2) {
    const maybeParam = segments[resourceIndex - 1];
    if (maybeParam?.startsWith("{")) {
      parent = segments[resourceIndex - 2];
    }
  }

  const prefixParts = segments
    .slice(0, Math.max(0, resourceIndex - (parent ? 2 : 0)))
    .filter((segment) => !segment.startsWith("{"));

  const singularizeTarget =
    isItem || m === "post" || m === "patch" || m === "delete";

  const parentAndResource = parent
    ? `${toDisplayWords(parent, true)} ${toDisplayWords(resourceSegment, singularizeTarget)}`
    : toDisplayWords(resourceSegment, singularizeTarget);

  const phrase = [
    ...prefixParts.map((segment) => toDisplayWords(segment, true)),
    parentAndResource,
  ].join(" ");

  if (m === "get") {
    return isItem ? `Get ${phrase}` : `List ${phrase}`;
  }
  if (m === "post") {
    return `Create ${phrase}`;
  }
  if (m === "patch" || m === "put") {
    return `Update ${phrase}`;
  }
  if (m === "delete") {
    return `Delete ${phrase}`;
  }

  return `${method.toUpperCase()} ${path}`;
}

const rawDoc: unknown = app.getOpenAPIDocument({
  openapi: "3.0.0",
  info: {
    title: "Pile",
    version: "0.1.0",
    description: "OpenAPI source of truth for REST, CLI, and MCP surfaces.",
  },
});

if (!isRecord(rawDoc)) {
  throw new Error("generated OpenAPI document is not an object");
}

const paths = rawDoc.paths;
if (!isRecord(paths)) {
  throw new Error("generated OpenAPI document has no paths");
}

for (const [path, methods] of Object.entries(paths)) {
  if (!isRecord(methods)) continue;
  for (const method of httpMethods) {
    const operation = methods[method];
    if (!isRecord(operation)) continue;
    if (
      typeof operation.summary !== "string" ||
      operation.summary.length === 0
    ) {
      operation.summary = makeSummary(method, path);
    }
  }
}

writeFileSync(outputPath, `${JSON.stringify(rawDoc, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, proof: "openapi", path: outputPath }));

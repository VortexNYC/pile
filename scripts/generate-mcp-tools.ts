#!/usr/bin/env -S tsx
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const specPath = resolve(repoRoot, "src/mcp/openapi.json");
const outputPath = resolve(repoRoot, "src/mcp/mcp-tools.ts");

const EXCLUDED_PATH_PREFIXES = [
  "/github",
  "/health",
  "/workspaces/{workspaceId}/ws",
  "/openapi",
] as const;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const CURATED_OPERATION_ID = /^[a-z][a-zA-Z0-9]*$/u;

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  console.error(`generate-mcp-tools: ${message}`);
  process.exit(1);
}

function generateOperationId(method: string, path: string): string {
  const prefix = method.toLowerCase();
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.replace(/^\{(.*)\}$/u, "$1").replace(/^[a-z]/u, (c) => c.toLowerCase())
    )
    .map((segment) => segment.replace(/(?:^|_)([a-z])/gu, (_, c) => c.toUpperCase()));
  const candidate = `${prefix}${segments.join("")}`;
  return candidate.replace(/[^a-zA-Z0-9]/gu, "");
}

const specRaw: unknown = JSON.parse(readFileSync(specPath, "utf8"));
if (!isRecord(specRaw) || !isRecord(specRaw.paths)) {
  fail("public spec has no paths");
}
const components = isRecord(specRaw.components) ? specRaw.components : {};
const schemas = isRecord(components.schemas) ? components.schemas : {};

function collectDefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDefs(item, into);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = value.replace("#/components/schemas/", "");
      if (name !== value && !into.has(name)) {
        into.add(name);
        collectDefs(schemas[name], into);
      }
      continue;
    }
    collectDefs(value, into);
  }
}

function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === "$ref" && typeof value === "string"
        ? value.replace("#/components/schemas/", "#/$defs/")
        : rewriteRefs(value);
  }
  return out;
}

interface GeneratedTool {
  readonly name: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly inputSchema: Record<string, unknown>;
}

const tools: GeneratedTool[] = [];

for (const [path, methodsRaw] of Object.entries(specRaw.paths)) {
  if (!isRecord(methodsRaw)) continue;
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
  if (path.includes("{tail}")) continue;

  for (const method of HTTP_METHODS) {
    const operationRaw = methodsRaw[method];
    if (!isRecord(operationRaw)) continue;

    let operationId: string | undefined;
    if (
      typeof operationRaw.operationId === "string" &&
      CURATED_OPERATION_ID.test(operationRaw.operationId)
    ) {
      operationId = operationRaw.operationId;
    }
    if (operationId === undefined) {
      operationId = generateOperationId(method, path);
    }

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const parameters = Array.isArray(operationRaw.parameters)
      ? operationRaw.parameters
      : [];
    for (const parameterRaw of parameters) {
      if (!isRecord(parameterRaw)) continue;
      const name = parameterRaw.name;
      const location = parameterRaw.in;
      if (typeof name !== "string" || typeof location !== "string") continue;
      if (location !== "path" && location !== "query") continue;
      const schema = isRecord(parameterRaw.schema)
        ? rewriteRefs(parameterRaw.schema)
        : { type: "string" };
      properties[name] = isRecord(schema)
        ? {
            ...schema,
            ...(typeof parameterRaw.description === "string"
              ? { description: parameterRaw.description }
              : {}),
          }
        : schema;
      if (parameterRaw.required === true || location === "path") {
        required.push(name);
      }
    }

    const requestBody = isRecord(operationRaw.requestBody)
      ? operationRaw.requestBody
      : undefined;
    const bodyContent =
      requestBody !== undefined && isRecord(requestBody.content)
        ? requestBody.content
        : undefined;
    const bodyJson =
      bodyContent !== undefined && isRecord(bodyContent["application/json"])
        ? bodyContent["application/json"]
        : undefined;
    const bodySchema =
      bodyJson !== undefined && isRecord(bodyJson.schema)
        ? bodyJson.schema
        : undefined;
    if (bodySchema !== undefined) {
      properties.body = rewriteRefs(bodySchema);
      if (requestBody?.required === true) {
        required.push("body");
      }
    }

    const defs = new Set<string>();
    collectDefs(parameters, defs);
    if (bodySchema !== undefined) collectDefs(bodySchema, defs);
    const $defs: Record<string, unknown> = {};
    for (const name of [...defs].sort()) {
      $defs[name] = rewriteRefs(schemas[name]);
    }

    const summary =
      typeof operationRaw.summary === "string" ? operationRaw.summary : "";
    const description =
      typeof operationRaw.description === "string" &&
      operationRaw.description.length > 0
        ? `${summary}${summary.length > 0 ? " — " : ""}${operationRaw.description}`
        : summary;

    tools.push({
      name: operationId,
      description: `${description} (${method.toUpperCase()} ${path})`.trim(),
      method: method.toUpperCase(),
      path,
      inputSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required: [...required].sort() } : {}),
        ...(Object.keys($defs).length > 0 ? { $defs } : {}),
      },
    });
  }
}

if (tools.length === 0) {
  fail("no tools generated -- the selector is wrong");
}

const sorted = [...tools].sort((left, right) =>
  left.name.localeCompare(right.name)
);

const source = `// Generated by scripts/generate-mcp-tools.ts from src/mcp/openapi.json.
// Do not edit by hand: run \`pnpm run mcp:generate\`.

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: readonly McpToolDefinition[] = ${JSON.stringify(sorted, null, 2)} as const;
`;

writeFileSync(outputPath, source);

console.log(
  JSON.stringify({ ok: true, proof: "mcp-tools", tools: sorted.length })
);

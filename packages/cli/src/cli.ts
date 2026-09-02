import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

type JsonObject = { readonly [key: string]: Json };

type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

const HTTP_METHODS: readonly HttpMethod[] = [
  "DELETE",
  "GET",
  "PATCH",
  "POST",
  "PUT",
];

const defaultBaseUrl = "http://127.0.0.1:8787";
const mutatingMethods = new Set<HttpMethod>(["DELETE", "PATCH", "POST", "PUT"]);

export type CliDeps = {
  readonly fetch?: typeof fetch;
};

function isJsonValue(value: unknown): value is Json {
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function parseJson(text: string): Json {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonValue(parsed)) {
    throw new Error("Expected valid JSON");
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

type ParsedArgs = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
};

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(
        equalsIndex + 1
      );
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[withoutPrefix] = next;
      index += 1;
      continue;
    }
    flags[withoutPrefix] = true;
  }
  return { positionals, flags };
}

function flagString(
  flags: Readonly<Record<string, string | boolean>>,
  key: string
): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonObjectFlag(
  flags: Readonly<Record<string, string | boolean>>,
  key: string
): JsonObject | undefined {
  const raw = flagString(flags, key);
  if (raw === undefined) return undefined;
  const parsed = parseJson(raw);
  if (!isJsonObject(parsed)) {
    throw new Error(`Expected --${key} to be a JSON object`);
  }
  return parsed;
}

type CliConfig = {
  readonly baseUrl?: string;
  readonly apiKey?: string;
};

function configPath(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is required");
  }
  return join(home, ".issuetracker", "config.json");
}

function readStoredConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  const parsed: unknown = parseJson(readFileSync(path, "utf8"));
  if (!isJsonObject(parsed)) return {};
  return {
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
  };
}

function resolveConfig(): Required<Pick<CliConfig, "baseUrl">> & CliConfig {
  const stored = readStoredConfig();
  return {
    ...stored,
    baseUrl:
      process.env.ISSUETRACKER_BASE_URL ?? stored.baseUrl ?? defaultBaseUrl,
    apiKey: process.env.ISSUETRACKER_API_KEY ?? stored.apiKey,
  };
}

function writeStoredConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function requestCommand(
  positionals: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const methodRaw = (positionals[1] ?? "").toUpperCase();
  if (!isHttpMethod(methodRaw)) {
    throw new Error(
      "Usage: issuetracker request METHOD PATH [--body-json ...]"
    );
  }
  const method = methodRaw;
  const path = positionals[2];
  if (path === undefined) {
    throw new Error(
      "Usage: issuetracker request METHOD PATH [--body-json ...]"
    );
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set ISSUETRACKER_API_KEY or run `issuetracker config set --api-key <key>`."
    );
  }

  const body = parseJsonObjectFlag(flags, "body-json");

  const targetUrl = new URL(path, config.baseUrl.replace(/\/$/u, ""));
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${config.apiKey}`);

  const idempotencyKey = flagString(flags, "idempotency-key");
  if (idempotencyKey !== undefined && mutatingMethods.has(method)) {
    headers.set("Idempotency-Key", idempotencyKey);
  }

  const bodyText = body !== undefined ? JSON.stringify(body) : undefined;
  if (bodyText !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(targetUrl, {
    method,
    headers,
    body: bodyText,
  });

  const text = await response.text();
  try {
    const parsed = parseJson(text);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(text);
  }

  return response.ok ? 0 : 1;
}

async function configSetCommand(
  flags: Readonly<Record<string, string | boolean>>
): Promise<number> {
  const baseUrl = flagString(flags, "base-url");
  const apiKey = flagString(flags, "api-key");
  const stored = readStoredConfig();
  writeStoredConfig({
    baseUrl: baseUrl ?? stored.baseUrl,
    apiKey: apiKey ?? stored.apiKey,
  });
  return 0;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  deps: CliDeps = {}
): Promise<number> {
  try {
    const { positionals, flags } = parseArgs(args);
    const [scope] = positionals;

    if (scope === "request") {
      return await requestCommand(positionals, flags, deps);
    }

    if (scope === "config" && positionals[1] === "set") {
      return await configSetCommand(flags);
    }

    console.log(`Usage: issuetracker [request | config set]`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

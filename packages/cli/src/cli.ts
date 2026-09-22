import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { COMMANDS } from "./commands.js";

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
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: {
      shell?: boolean;
      stdio?: ["ignore", "pipe", "pipe"];
    }
  ) => {
    stdout: { on: (event: "data", cb: (data: Buffer) => void) => void };
    stderr: { on: (event: "data", cb: (data: Buffer) => void) => void };
    on: (event: "close", cb: (code: number | null) => void) => void;
  };
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
  readonly capturePublicKey?: string;
  readonly session?: string;
};

function configPath(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is required");
  }
  return join(home, ".pile", "config.json");
}

function readStoredConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  const parsed: unknown = parseJson(readFileSync(path, "utf8"));
  if (!isJsonObject(parsed)) return {};
  return {
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
    capturePublicKey:
      typeof parsed.capturePublicKey === "string"
        ? parsed.capturePublicKey
        : undefined,
    session: typeof parsed.session === "string" ? parsed.session : undefined,
  };
}

function resolveConfig(): Required<Pick<CliConfig, "baseUrl">> & CliConfig {
  const stored = readStoredConfig();
  return {
    ...stored,
    baseUrl: process.env.PILE_BASE_URL ?? stored.baseUrl ?? defaultBaseUrl,
    apiKey: process.env.PILE_API_KEY ?? stored.apiKey,
    capturePublicKey:
      process.env.PILE_CAPTURE_PUBLIC_KEY ?? stored.capturePublicKey,
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
    throw new Error("Usage: pile request METHOD PATH [--body-json ...]");
  }
  const method = methodRaw;
  const path = positionals[2];
  if (path === undefined) {
    throw new Error("Usage: pile request METHOD PATH [--body-json ...]");
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  const body =
    parseJsonObjectFlag(flags, "body-json") ??
    parseJsonObjectFlag(flags, "body");

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

function findCommand(positionals: readonly string[]): [string, string[]] {
  for (let end = positionals.length; end > 0; end -= 1) {
    const key = positionals.slice(0, end).join(" ");
    if (key in COMMANDS) {
      return [key, positionals.slice(end)];
    }
  }
  return ["", []];
}

async function commandCommand(
  positionals: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const [name, args] = findCommand(positionals);
  if (!name) {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }
  const def = COMMANDS[name];
  if (!def) {
    throw new Error(`Unknown command: ${name}`);
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  let path = def.path;
  const remaining = [...args];
  for (const param of def.params) {
    let value: string | undefined;
    if (param.flag === "workspace") {
      value =
        flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
    } else {
      const flagValue = flagString(flags, param.flag);
      if (flagValue !== undefined) {
        value = flagValue;
      } else if (remaining.length > 0) {
        value = remaining.shift();
      }
    }
    if (value === undefined) {
      throw new Error(`Missing required parameter: --${param.flag}`);
    }
    path = path.replace(`{${param.name}}`, value);
  }

  const url = new URL(path, config.baseUrl.replace(/\/$/u, ""));
  for (const param of def.query) {
    const value = flagString(flags, param.flag);
    if (value !== undefined) {
      url.searchParams.set(param.name, value);
    }
  }
  const queryJson = parseJsonObjectFlag(flags, "query-json");
  if (queryJson !== undefined) {
    for (const [key, value] of Object.entries(queryJson)) {
      url.searchParams.set(key, String(value));
    }
  }

  function parseBodyFlagValue(raw: string): unknown {
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        return parseJson(raw);
      } catch {
        // keep as string if it looked like JSON but was not
      }
    }
    return raw;
  }

  const bodyJson = parseJsonObjectFlag(flags, "body-json");
  const body: Record<string, unknown> = bodyJson ? { ...bodyJson } : {};
  for (const field of def.body) {
    const value = flags[field.flag];
    if (value === true) {
      body[field.name] = true;
    } else if (typeof value === "string") {
      body[field.name] = parseBodyFlagValue(value);
    }
  }

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  const idempotencyKey = flagString(flags, "idempotency-key");
  if (
    idempotencyKey !== undefined &&
    mutatingMethods.has(def.method as HttpMethod)
  ) {
    headers.set("Idempotency-Key", idempotencyKey);
  }

  const bodyText =
    Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;
  if (bodyText !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(url, {
    method: def.method,
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

function getSetCookie(headers: Headers): readonly string[] {
  const h = headers as unknown as { getSetCookie?(): string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  if (raw === null) return [];
  return [raw];
}

async function authLoginCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const email = process.env.PILE_EMAIL ?? flagString(flags, "email");
  const password = process.env.PILE_PASSWORD ?? flagString(flags, "password");
  const workspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (email === undefined || email.length === 0) {
    throw new Error("Missing email. Set PILE_EMAIL or use --email <email>.");
  }
  if (password === undefined || password.length === 0) {
    throw new Error(
      "Missing password. Set PILE_PASSWORD or use --password <password>."
    );
  }
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("Missing --workspace. Use --workspace <org>.");
  }

  const stored = readStoredConfig();
  const baseUrl = (
    process.env.PILE_BASE_URL ??
    stored.baseUrl ??
    defaultBaseUrl
  ).replace(/\/$/u, "");
  const doFetch = deps.fetch ?? fetch;

  const signInRes = await doFetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const signInText = await signInRes.text();
  if (!signInRes.ok) {
    throw new Error(`Sign in failed: ${signInRes.status} ${signInText}`);
  }
  const cookies = getSetCookie(signInRes.headers);
  const sessionCookie = cookies.find(
    (c) => c.startsWith("session_token=") || c.includes("session_token=")
  );
  if (sessionCookie === undefined) {
    throw new Error("Sign in succeeded but no session cookie returned");
  }
  const cookie = sessionCookie.split(";")[0]?.trim();
  if (cookie === undefined || cookie.length === 0) {
    throw new Error("Sign in succeeded but no session cookie returned");
  }

  const tokenRes = await doFetch(`${baseUrl}/workspaces/${workspace}/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ name: "cli", permissions: ["admin"] }),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    throw new Error(`Token creation failed: ${tokenRes.status} ${tokenText}`);
  }
  const tokenBody = parseJson(tokenText);
  if (
    !isJsonObject(tokenBody) ||
    typeof tokenBody.token !== "string" ||
    tokenBody.token.length === 0
  ) {
    throw new Error("Token creation returned an unexpected response");
  }
  writeStoredConfig({
    ...stored,
    baseUrl,
    apiKey: tokenBody.token,
    session: cookie,
  });
  console.log(JSON.stringify({ ok: true, workspace }, null, 2));
  return 0;
}

async function authStatusCommand(
  _flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const stored = readStoredConfig();
  const baseUrl = (
    process.env.PILE_BASE_URL ??
    stored.baseUrl ??
    defaultBaseUrl
  ).replace(/\/$/u, "");
  const session =
    process.env.PILE_SESSION ??
    stored.session ??
    process.env.PILE_SESSION_TOKEN;
  if (session === undefined || session.length === 0) {
    throw new Error("No session. Run `pile auth login` first.");
  }
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/api/auth/get-session`, {
    headers: { Cookie: session },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Session check failed: ${res.status} ${text}`);
  }
  console.log(text);
  return 0;
}

async function authLogoutCommand(
  _flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const stored = readStoredConfig();
  const baseUrl = (
    process.env.PILE_BASE_URL ??
    stored.baseUrl ??
    defaultBaseUrl
  ).replace(/\/$/u, "");
  const session =
    process.env.PILE_SESSION ??
    stored.session ??
    process.env.PILE_SESSION_TOKEN;
  if (session === undefined || session.length === 0) {
    throw new Error("No session. Run `pile auth login` first.");
  }
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: { Cookie: session },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sign out failed: ${res.status} ${text}`);
  }
  writeStoredConfig({
    ...stored,
    session: undefined,
  });
  console.log(text);
  return 0;
}

async function configSetCommand(
  flags: Readonly<Record<string, string | boolean>>
): Promise<number> {
  const baseUrl = flagString(flags, "base-url");
  const apiKey = flagString(flags, "api-key");
  const capturePublicKey = flagString(flags, "capture-public-key");
  const stored = readStoredConfig();
  writeStoredConfig({
    baseUrl: baseUrl ?? stored.baseUrl,
    apiKey: apiKey ?? stored.apiKey,
    capturePublicKey: capturePublicKey ?? stored.capturePublicKey,
  });
  return 0;
}

type ConsoleLogEntry = {
  console_level: string;
  console_value: string;
  is_error: boolean;
};

function findVideoArtifact(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir);
  for (const name of names) {
    if (name.endsWith(".webm") || name.endsWith(".mp4")) {
      return join(dir, name);
    }
  }
  return undefined;
}

async function captureRunCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const config = resolveConfig();
  const publicKey =
    flagString(flags, "public-key") ??
    flagString(flags, "capture-public-key") ??
    config.capturePublicKey;
  if (publicKey === undefined || publicKey.length === 0) {
    throw new Error(
      "Missing capture public key. Set PILE_CAPTURE_PUBLIC_KEY, use --public-key, or run `pile config set --capture-public-key <key>`."
    );
  }

  const command = flagString(flags, "command");
  if (command === undefined || command.length === 0) {
    throw new Error(
      "Missing command. Use --command 'pnpm test' or pass the command after a -- separator."
    );
  }

  const title =
    flagString(flags, "title") ??
    (command.length > 60 ? `${command.slice(0, 60)}...` : command);
  const description = flagString(flags, "description") ?? "";
  const visibility = flagString(flags, "visibility") ?? "private";
  const artifactsDir = flagString(flags, "artifacts-dir") ?? "test-results";

  const doFetch = deps.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/$/u, "");

  const tokenRes = await doFetch(`${base}/support/capture/token`, {
    method: "POST",
    headers: {
      "x-pile-capture-public-key": publicKey,
      origin: "@vortex-api/pile",
    },
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(
      `Failed to create capture session: ${tokenRes.status} ${text}`
    );
  }
  const tokenBody = (await tokenRes.json()) as { token: string };
  const token = tokenBody.token;

  const consoleLogs: ConsoleLogEntry[] = [];
  const child = (deps.spawn ?? spawn)(command, [], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      consoleLogs.push({
        console_level: "log",
        console_value: line,
        is_error: false,
      });
    }
    process.stdout.write(data);
  });

  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      consoleLogs.push({
        console_level: "error",
        console_value: line,
        is_error: true,
      });
    }
    process.stderr.write(data);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });

  const metadataRes = await doFetch(`${base}/support/capture/metadata`, {
    method: "POST",
    headers: {
      "x-pile-capture-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      metadata: {
        title,
        description,
        source: "cli",
        consoleCount: consoleLogs.length,
        email: "ci@pile.local",
      },
    }),
  });
  if (!metadataRes.ok) {
    const text = await metadataRes.text();
    throw new Error(
      `Failed to set capture metadata: ${metadataRes.status} ${text}`
    );
  }

  async function uploadArtifact(
    attachmentType: string,
    contentType: string,
    fileName: string | null,
    buffer: Buffer
  ): Promise<void> {
    const reserveRes = await doFetch(`${base}/support/capture/upload-session`, {
      method: "POST",
      headers: {
        "x-pile-capture-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attachmentType,
        contentType,
        fileName,
        title,
        visibility,
        metadata: { email: "ci@pile.local" },
      }),
    });
    if (!reserveRes.ok) {
      const text = await reserveRes.text();
      throw new Error(
        `Failed to reserve upload for ${attachmentType}: ${reserveRes.status} ${text}`
      );
    }
    const reserveBody = (await reserveRes.json()) as {
      uploadUrl: string;
    };
    const uploadRes = await doFetch(`${base}${reserveBody.uploadUrl}`, {
      method: "POST",
      headers: {
        "x-pile-capture-token": token,
        "content-type": contentType,
      },
      body: new Blob(
        [
          new Uint8Array(
            buffer.buffer as ArrayBuffer,
            buffer.byteOffset,
            buffer.byteLength
          ),
        ],
        { type: contentType }
      ),
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(
        `Failed to upload ${attachmentType}: ${uploadRes.status} ${text}`
      );
    }
  }

  const consoleBuffer = Buffer.from(JSON.stringify(consoleLogs, null, 2));
  await uploadArtifact(
    "log",
    "application/json",
    "console-logs.json",
    consoleBuffer
  );

  const videoPath = findVideoArtifact(artifactsDir);
  if (videoPath !== undefined) {
    const videoBuffer = readFileSync(videoPath);
    const contentType = videoPath.endsWith(".mp4") ? "video/mp4" : "video/webm";
    await uploadArtifact(
      "video",
      contentType,
      videoPath.split("/").pop() ?? null,
      videoBuffer
    );
  }

  const finalizeRes = await doFetch(`${base}/support/capture/finalize`, {
    method: "POST",
    headers: {
      "x-pile-capture-token": token,
    },
  });
  if (!finalizeRes.ok) {
    const text = await finalizeRes.text();
    throw new Error(
      `Failed to finalize capture: ${finalizeRes.status} ${text}`
    );
  }
  const finalizeBody = (await finalizeRes.json()) as {
    ticketId: string;
    shareUrl: string;
  };

  console.log(JSON.stringify(finalizeBody, null, 2));
  return exitCode;
}

function printUsage(): void {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(COMMANDS)) {
    const [group, ...rest] = name.split(" ");
    const list = groups.get(group) ?? [];
    list.push(rest.join(" "));
    groups.set(group, list);
  }
  console.log("pile — Pile CLI\n");
  console.log("Usage: pile <command> [flags]\n");
  console.log("Core commands:");
  for (const cmd of [
    "auth login",
    "auth status",
    "auth logout",
    "config set",
    "request <METHOD> <path>",
    "capture run",
  ]) {
    console.log(`  ${cmd}`);
  }
  console.log("\nAPI commands:");
  for (const [group, subs] of groups) {
    console.log(`  ${group}: ${subs.join(", ")}`);
  }
  console.log(
    "\nConfig: PILE_BASE_URL, PILE_API_KEY, or `pile config set --base-url <url> --api-key <key>`"
  );
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  deps: CliDeps = {}
): Promise<number> {
  try {
    const { positionals, flags } = parseArgs(args);
    const [scope] = positionals;

    if (
      positionals.length === 0 ||
      flags.help === true ||
      flags.h === true ||
      scope === "help"
    ) {
      printUsage();
      return 0;
    }

    if (scope === "request") {
      return await requestCommand(positionals, flags, deps);
    }

    if (scope === "auth" && positionals[1] === "login") {
      return await authLoginCommand(flags, deps);
    }

    if (scope === "auth" && positionals[1] === "status") {
      return await authStatusCommand(flags, deps);
    }

    if (scope === "auth" && positionals[1] === "logout") {
      return await authLogoutCommand(flags, deps);
    }

    if (scope === "config" && positionals[1] === "set") {
      return await configSetCommand(flags);
    }

    if (scope === "capture" && positionals[1] === "run") {
      return await captureRunCommand(flags, deps);
    }

    return await commandCommand(positionals, flags, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

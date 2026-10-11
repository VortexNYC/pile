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
import { fleetCommand, type FleetDeps } from "./fleet.js";
import { homeCommand } from "./home.js";
import { inboxCommand, type InboxDeps } from "./inbox.js";
import { supportCommand, type InboxDeps as SupportDeps } from "./support.js";
import { checkTuiSupport, errorMessage } from "./tui.js";

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
  // Test seam for `pile tui-check` — the real probe loads @opentui/core.
  readonly probeTui?: () => Promise<unknown>;
};

export function isJsonValue(value: unknown): value is Json {
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function parseJson(text: string): Json {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonValue(parsed)) {
    throw new Error("Expected valid JSON");
  }
  return parsed;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

type ParsedArgs = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
  // Every string value a flag received, in order — repeated flags like
  // `--item a --item b` collapse to the last value in `flags`.
  readonly multi: Readonly<Record<string, readonly string[]>>;
};

const BOOLEAN_FLAGS = new Set(["follow", "help", "poll"]);

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  const record = (key: string, value: string | boolean) => {
    flags[key] = value;
    if (typeof value === "string") {
      (multi[key] ??= []).push(value);
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      record(
        withoutPrefix.slice(0, equalsIndex),
        withoutPrefix.slice(equalsIndex + 1)
      );
      continue;
    }
    const next = args[index + 1];
    if (
      next !== undefined &&
      !next.startsWith("--") &&
      !BOOLEAN_FLAGS.has(withoutPrefix)
    ) {
      record(withoutPrefix, next);
      index += 1;
      continue;
    }
    record(withoutPrefix, true);
  }
  return { positionals, flags, multi };
}

export function flagString(
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
  readonly workspace?: string;
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
    workspace:
      typeof parsed.workspace === "string" ? parsed.workspace : undefined,
  };
}

export function resolveConfig(): Required<Pick<CliConfig, "baseUrl">> &
  CliConfig {
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
  const { ok, text } = await executeCommand(positionals, flags, deps);
  printResponse(text);
  return ok ? 0 : 1;
}

function printResponse(text: string): void {
  try {
    console.log(JSON.stringify(parseJson(text), null, 2));
  } catch {
    console.log(text);
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

async function executeCommand(
  positionals: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<{ readonly ok: boolean; readonly text: string }> {
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

  return { ok: response.ok, text: await response.text() };
}

// `pile issues dispatch <id> --workspace <org> --follow` — dispatches, then
// watches the lane until it opens a PR, reaches a terminal status, or times out.
async function dispatchFollowCommand(
  positionals: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const { ok, text } = await executeCommand(positionals, flags, deps);
  printResponse(text);
  if (!ok) return 1;
  const parsed: unknown = parseJson(text);
  const sessionId =
    isJsonObject(parsed) && typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  if (sessionId === undefined) {
    throw new Error("Dispatch response did not include a session id");
  }
  // Stable console link — the console resolves workspace id-or-slug.
  const watchWorkspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (watchWorkspace !== undefined) {
    const baseUrl = resolveConfig().baseUrl.replace(/\/$/u, "");
    console.log(
      `console: ${baseUrl}/app/${watchWorkspace}/sessions/${sessionId}`
    );
  }
  return await sessionWatchCommand(sessionId, flags, deps, { untilPr: true });
}

// `pile agent dispatch-batch --workspace <org> --file batch.json` — or items
// inline: repeated `--item <issueId|'{"issueId":…}'>` flags, or `--items` as a
// JSON array. POSTs one batch dispatch and prints per-item results.
async function agentDispatchBatchCommand(
  flags: Readonly<Record<string, string | boolean>>,
  multi: Readonly<Record<string, readonly string[]>>,
  deps: CliDeps = {}
): Promise<number> {
  const workspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("Missing --workspace. Use --workspace <org>.");
  }

  const items: Json[] = [];
  const file = flagString(flags, "file");
  if (file !== undefined) {
    const parsed = parseJson(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      items.push(...parsed);
    } else if (isJsonObject(parsed) && Array.isArray(parsed.items)) {
      items.push(...parsed.items);
    } else {
      throw new Error(
        "Expected --file to contain a JSON array or an object with an items array"
      );
    }
  }
  const inline = flagString(flags, "items");
  if (inline !== undefined) {
    const parsed = parseJson(inline);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected --items to be a JSON array");
    }
    items.push(...parsed);
  }
  for (const raw of multi.item ?? []) {
    items.push(raw.startsWith("{") ? parseJson(raw) : { issueId: raw });
  }
  if (items.length === 0) {
    throw new Error(
      "Usage: pile agent dispatch-batch --workspace <org> (--file batch.json | --items '<json>' | --item <issueId|json> repeated)"
    );
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  const baseUrl = config.baseUrl.replace(/\/$/u, "");
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(
    `${baseUrl}/workspaces/${workspace}/agent/dispatch-batch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items }),
    }
  );
  printResponse(await response.text());
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
      // Cookie-authed POSTs must pass the CSRF origin check; the CLI is a
      // first-party client, so assert the target origin explicitly.
      Origin: new URL(baseUrl).origin,
    },
    // The server clamps to the caller's workspace role, so a member gets
    // read,write while an admin keeps the full set.
    body: JSON.stringify({
      name: "cli",
      permissions: ["read", "write", "admin"],
    }),
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

async function initCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const email = flagString(flags, "email") ?? process.env.PILE_EMAIL;
  const password = flagString(flags, "password") ?? process.env.PILE_PASSWORD;
  const name = flagString(flags, "name") ?? flagString(flags, "workspace-name");
  if (email === undefined || email.length === 0) {
    throw new Error("Missing email. Set PILE_EMAIL or use --email <email>.");
  }
  if (password === undefined || password.length === 0) {
    throw new Error(
      "Missing password. Set PILE_PASSWORD or use --password <password>."
    );
  }
  if (name === undefined || name.length === 0) {
    throw new Error(
      "Missing workspace name. Use --name <name> (e.g. --name Acme)."
    );
  }

  const stored = readStoredConfig();
  const baseUrl = (
    process.env.PILE_BASE_URL ??
    stored.baseUrl ??
    defaultBaseUrl
  ).replace(/\/$/u, "");
  const doFetch = deps.fetch ?? fetch;
  const origin = new URL(baseUrl).origin;
  const jsonHeaders = { "Content-Type": "application/json", Origin: origin };

  // Sign in; if the account does not exist yet, create it and retry.
  let signInRes = await doFetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  if (!signInRes.ok) {
    const signUpRes = await doFetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email, password, name: email.split("@")[0] }),
    });
    if (!signUpRes.ok) {
      const text = await signUpRes.text();
      throw new Error(
        `Sign in failed and sign up failed: ${signUpRes.status} ${text}`
      );
    }
    signInRes = await doFetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    if (!signInRes.ok) {
      const text = await signInRes.text();
      throw new Error(
        `Sign in failed after sign up: ${signInRes.status} ${text}`
      );
    }
  }
  const cookies = getSetCookie(signInRes.headers);
  const sessionCookie = cookies.find((c) => c.includes("session_token="));
  if (sessionCookie === undefined) {
    throw new Error("Sign in succeeded but no session cookie returned");
  }
  const cookie = sessionCookie.split(";")[0]?.trim();
  if (cookie === undefined || cookie.length === 0) {
    throw new Error("Sign in succeeded but no session cookie returned");
  }

  const slug =
    flagString(flags, "slug") ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  const key =
    flagString(flags, "key") ??
    name
      .replace(/[^a-zA-Z]/g, "")
      .slice(0, 3)
      .toUpperCase();

  const onboardRes = await doFetch(`${baseUrl}/workspaces/onboard`, {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: cookie },
    body: JSON.stringify({ name, slug, key }),
  });
  const onboardText = await onboardRes.text();
  if (!onboardRes.ok) {
    throw new Error(`Onboard failed: ${onboardRes.status} ${onboardText}`);
  }
  const onboard = parseJson(onboardText);
  if (
    !isJsonObject(onboard) ||
    !isJsonObject(onboard.workspace) ||
    typeof onboard.workspace.id !== "string" ||
    typeof onboard.token !== "string"
  ) {
    throw new Error("Onboard returned an unexpected response");
  }

  writeStoredConfig({
    ...stored,
    baseUrl,
    apiKey: onboard.token,
    session: cookie,
    workspace: onboard.workspace.id,
  });

  console.log(`Signed in as ${email}`);
  console.log(
    `Workspace "${name}" ready — ${onboard.workspace.id} (slug ${slug})`
  );
  console.log(`API key saved to ${configPath()}`);
  console.log("");
  console.log("Next:");
  console.log(
    `  pile issues create --workspace ${onboard.workspace.id} --title "First issue" --team-id ${(onboard.team as { id?: string })?.id ?? "<team>"}`
  );
  console.log(
    `  pile support capture links create --workspace ${onboard.workspace.id}`
  );
  return 0;
}

const CLI_VERSION = "0.1.6";

async function feedbackCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const message = flagString(flags, "message") ?? flagString(flags, "m");
  if (message === undefined || message.length < 20) {
    throw new Error(
      'Feedback needs at least 20 characters. Use --message "…" with enough detail to act on.'
    );
  }
  const subject = flagString(flags, "subject") ?? message.slice(0, 80);
  const email = flagString(flags, "email") ?? process.env.PILE_EMAIL;
  if (email === undefined || email.length === 0) {
    throw new Error(
      "Missing email. Use --email <you@co> or set PILE_EMAIL so we can follow up."
    );
  }

  const stored = readStoredConfig();
  const baseUrl = (
    process.env.PILE_BASE_URL ??
    stored.baseUrl ??
    defaultBaseUrl
  ).replace(/\/$/u, "");
  const doFetch = deps.fetch ?? fetch;

  const res = await doFetch(`${baseUrl}/support/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject,
      text: `${message}\n\nnode: ${process.version}`,
      fromEmail: email,
      fromName: flagString(flags, "name") ?? "pile CLI user",
      context: {
        client: "pile-cli",
        version: CLI_VERSION,
        os: `${process.platform} ${process.arch}`,
        workspace: stored.workspace,
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Feedback failed: ${res.status} ${text}`);
  }
  const body = parseJson(text);
  const ticketNumber =
    isJsonObject(body) && typeof body.ticketNumber === "number"
      ? body.ticketNumber
      : undefined;
  console.log(
    ticketNumber !== undefined
      ? `Thanks — filed as ticket #${ticketNumber} in the Pile workspace.`
      : "Thanks — feedback filed."
  );
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
    "init --email <email> --password <pw> --name <workspace>",
    "feedback --message <text>",
    "auth login",
    "auth status",
    "auth logout",
    "config set",
    "request <METHOD> <path>",
    "capture run",
    "agent context pull --workspace <org> [--dir .]",
    "agent context push --workspace <org> [--dir .]",
    "agent sessions watch <sessionId> --workspace <org>",
    "home [--workspace <org>] — bare `pile` opens this",
    "fleet --workspace <org> [--poll]",
    "support --workspace <org>",
    "inbox --workspace <org>",
    "agent dispatch-batch --workspace <org> --file batch.json",
    "memberships invite --workspace <org> --email <e> [--role member|admin|owner] [--team <id>]",
    "issues dispatch <id> --workspace <org> --follow [--timeout <min>]",
    "tui-check — verify OpenTUI (module + native library) loads",
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

// `pile agent context pull|push --workspace <org> [--dir .]` — syncs the
// workspace agent context to/from local files: AGENTS.md, .devin/rules/*.md,
// .devin/skills/<name>/SKILL.md.
async function agentContextCommand(
  direction: "pull" | "push",
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {}
): Promise<number> {
  const workspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("Missing --workspace. Use --workspace <org>.");
  }
  const dir = flagString(flags, "dir") ?? ".";

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  const baseUrl = config.baseUrl.replace(/\/$/u, "");
  const url = `${baseUrl}/workspaces/${workspace}/agent-context`;
  const headers = new Headers({ Authorization: `Bearer ${config.apiKey}` });
  const doFetch = deps.fetch ?? fetch;

  if (direction === "pull") {
    const response = await doFetch(url, { method: "GET", headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to pull agent context: ${response.status} ${text}`
      );
    }
    const parsed: unknown = JSON.parse(await response.text());
    if (!isJsonObject(parsed)) {
      throw new Error("Unexpected agent context response");
    }
    const written: string[] = [];

    if (typeof parsed.agentsMd === "string" && parsed.agentsMd.length > 0) {
      const path = join(dir, "AGENTS.md");
      writeFileSync(path, parsed.agentsMd);
      written.push(path);
    }

    const writeEntries = (
      entries: unknown,
      baseDir: string,
      fileName: (name: string) => string
    ) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!isJsonObject(entry)) continue;
        const name = entry.name;
        const content = entry.content;
        if (typeof name !== "string" || typeof content !== "string") continue;
        mkdirSync(baseDir, { recursive: true });
        const path = join(baseDir, fileName(name));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(path);
      }
    };

    writeEntries(parsed.rules, join(dir, ".devin", "rules"), (n) => `${n}.md`);
    writeEntries(parsed.skills, join(dir, ".devin", "skills"), (n) =>
      join(n, "SKILL.md")
    );

    console.log(JSON.stringify({ ok: true, written }, null, 2));
    return 0;
  }

  const body: Record<string, unknown> = {};

  const agentsPath = join(dir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    body.agentsMd = readFileSync(agentsPath, "utf8");
  }

  const rulesDir = join(dir, ".devin", "rules");
  if (existsSync(rulesDir)) {
    body.rules = readdirSync(rulesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f.slice(0, -".md".length),
        content: readFileSync(join(rulesDir, f), "utf8"),
      }));
  }

  const skillsDir = join(dir, ".devin", "skills");
  if (existsSync(skillsDir)) {
    body.skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skillPath = join(skillsDir, entry.name, "SKILL.md");
        return {
          name: entry.name,
          description: "",
          content: existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "",
        };
      });
  }

  headers.set("Content-Type", "application/json");
  const response = await doFetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    console.log(JSON.stringify(parseJson(text), null, 2));
  } catch {
    console.log(text);
  }
  return response.ok ? 0 : 1;
}

// `pile tui-check` — verifies OpenTUI (module + native library) actually
// loads in this runtime. `build:bin` runs it against the freshly compiled
// binary: `bun build --compile` silently keeps an unresolvable
// `import("@opentui/core")` dynamic, which otherwise ships a binary whose TUI
// commands only fail at runtime.
async function tuiCheckCommand(deps: CliDeps = {}): Promise<number> {
  const probe = deps.probeTui ?? checkTuiSupport;
  try {
    await probe();
  } catch (error) {
    console.error(`tui-check: OpenTUI failed to load: ${errorMessage(error)}`);
    return 1;
  }
  console.log(JSON.stringify({ ok: true, tui: "opentui" }, null, 2));
  return 0;
}

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "canceled"]);

// `pile agent sessions watch <id> --workspace <org>` — tails the runner's
// live logs and session status until the session reaches a terminal state
// (or, with `untilPr`, opens a PR). Exits 0 on completed/PR, 1 on
// failed/canceled/error, 124 on timeout.
async function sessionWatchCommand(
  sessionId: string | undefined,
  flags: Readonly<Record<string, string | boolean>>,
  deps: CliDeps = {},
  { untilPr = false }: { readonly untilPr?: boolean } = {}
): Promise<number> {
  if (sessionId === undefined || sessionId.length === 0) {
    throw new Error(
      "Usage: pile agent sessions watch <sessionId> --workspace <org>"
    );
  }
  const workspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("Missing --workspace. Use --workspace <org>.");
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  const baseUrl = config.baseUrl.replace(/\/$/u, "");
  const url = `${baseUrl}/workspaces/${workspace}/agent/sessions/${sessionId}/state`;
  const headers = new Headers({ Authorization: `Bearer ${config.apiKey}` });
  const doFetch = deps.fetch ?? fetch;
  const intervalMs = Number(flagString(flags, "interval") ?? "4000");

  let lastStatus = "";
  let logOffset = 0;
  let idle = 0;
  const maxIdle =
    Number(
      flagString(flags, "timeout") ?? flagString(flags, "idle-minutes") ?? "70"
    ) *
    60 *
    1000;
  const started = Date.now();
  const timedOut = () => {
    if (idle <= maxIdle && Date.now() - started <= maxIdle) return false;
    console.error(
      `watch: timed out waiting for ${untilPr ? "PR or " : ""}terminal status`
    );
    return true;
  };
  const sleep = () => new Promise((resolve) => setTimeout(resolve, intervalMs));

  for (;;) {
    const res = await doFetch(url, { headers });
    if (!res.ok) {
      // /state 400s once the compute is destroyed (or when the provider has
      // no live state) — the session record itself still exists, so fall
      // back to it.
      const sessionRes = await doFetch(
        `${baseUrl}/workspaces/${workspace}/agent/sessions/${sessionId}?summary=1`,
        { headers }
      );
      if (!sessionRes.ok) {
        console.error(`watch: GET /state returned ${res.status}`);
        return 1;
      }
      const record = (await sessionRes.json()) as {
        session?: { status?: string; prUrl?: string | null };
        status?: string;
        prUrl?: string | null;
      };
      const flat = record.session ?? record;
      const status = flat.status ?? "";
      if (TERMINAL_SESSION_STATUSES.has(status)) {
        console.log(`status: ${status}`);
        if (flat.prUrl) console.log(`pr: ${flat.prUrl}`);
        return status === "completed" ? 0 : 1;
      }
      if (!untilPr) {
        console.error(`watch: GET /state returned ${res.status}`);
        return 1;
      }
      if (status !== lastStatus) {
        console.log(`status: ${status}`);
        lastStatus = status;
      }
      if (flat.prUrl) {
        console.log(`pr: ${flat.prUrl}`);
        return 0;
      }
      idle += intervalMs;
      if (timedOut()) return 124;
      await sleep();
      continue;
    }
    const state = (await res.json()) as {
      session?: {
        status?: string;
        result?: string | null;
        prUrl?: string | null;
        branch?: string | null;
      };
      provider?: { logs?: string | null } | null;
    };

    const status = state.session?.status ?? "unknown";
    if (status !== lastStatus) {
      console.log(`status: ${status}`);
      lastStatus = status;
    }

    const logs = state.provider?.logs ?? "";
    if (logs.length > logOffset) {
      process.stdout.write(logs.slice(logOffset));
      if (!logs.endsWith("\n")) process.stdout.write("\n");
      logOffset = logs.length;
      idle = 0;
    } else {
      idle += intervalMs;
    }

    if (TERMINAL_SESSION_STATUSES.has(status)) {
      const result = state.session?.result;
      const prUrl = state.session?.prUrl;
      if (result) console.log(result);
      if (prUrl) console.log(`pr: ${prUrl}`);
      return status === "completed" ? 0 : 1;
    }
    if (untilPr && state.session?.prUrl) {
      console.log(`pr: ${state.session.prUrl}`);
      return 0;
    }
    if (timedOut()) return 124;
    await sleep();
  }
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  deps: FleetDeps | SupportDeps | InboxDeps = {}
): Promise<number> {
  try {
    const { positionals, flags, multi } = parseArgs(args);
    const [scope] = positionals;

    // Bare `pile` on a TTY drops into the tabbed home (fleet / issues /
    // support); piped or non-interactive stays on plain usage text.
    if (positionals.length === 0 && process.stdout.isTTY === true) {
      return await homeCommand(flags, deps);
    }
    if (scope === "home") {
      return await homeCommand(flags, deps);
    }

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

    if (scope === "init") {
      return await initCommand(flags, deps);
    }

    if (scope === "feedback") {
      return await feedbackCommand(flags, deps);
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

    if (scope === "agent" && positionals[1] === "dispatch-batch") {
      return await agentDispatchBatchCommand(flags, multi, deps);
    }

    if (
      scope === "agent" &&
      positionals[1] === "context" &&
      (positionals[2] === "pull" || positionals[2] === "push")
    ) {
      return await agentContextCommand(positionals[2], flags, deps);
    }

    if (
      scope === "agent" &&
      positionals[1] === "sessions" &&
      positionals[2] === "watch"
    ) {
      return await sessionWatchCommand(positionals[3], flags, deps);
    }

    if (scope === "tui-check") {
      return await tuiCheckCommand(deps);
    }

    if (scope === "fleet") {
      return await fleetCommand(flags, deps as FleetDeps);
    }

    // `pile support` / `pile support inbox` open the triage TUI; longer
    // support subcommands (`support tickets list`, …) fall through to the
    // generated API commands.
    if (
      scope === "support" &&
      (positionals.length === 1 ||
        (positionals[1] === "inbox" && positionals.length === 2))
    ) {
      return await supportCommand(flags, deps as SupportDeps);
    }

    if (scope === "inbox" || (scope === "issues" && positionals.length === 1)) {
      return await inboxCommand(flags, deps);
    }

    if (
      scope === "issues" &&
      positionals[1] === "dispatch" &&
      flags.follow === true
    ) {
      return await dispatchFollowCommand(positionals, flags, deps);
    }

    // `pile memberships invite` is the membership-facing spelling of the
    // generated `invitations create` command; role defaults to member.
    if (scope === "memberships" && positionals[1] === "invite") {
      const inviteFlags =
        flags.role === undefined ? { ...flags, role: "member" } : flags;
      return await commandCommand(
        ["invitations", "create", ...positionals.slice(2)],
        inviteFlags,
        deps
      );
    }

    return await commandCommand(positionals, flags, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

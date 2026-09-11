import { z } from "zod";

import type {
  ImportBatchResult,
  ImportContext,
  ImportRunState,
  ImportSource,
  ImportValidationResult,
} from "../import/types.js";
import { VortexError } from "../platform/errors.js";
import { jamSupportImportSource } from "./jam.js";

const JAM_MCP_BASE = "https://mcp.jam.dev/mcp";

export const jamMcpSupportCredentialsSchema = z.object({
  token: z.string().min(1),
});
export type JamMcpSupportCredentials = z.infer<
  typeof jamMcpSupportCredentialsSchema
>;

export const jamMcpSupportOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
  after: z.string().optional(),
  text: z.string().optional(),
  type: z
    .enum(["video", "screenshot", "sessionReplay", "recording"])
    .optional(),
  folder: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
});
export type JamMcpSupportOptions = z.infer<typeof jamMcpSupportOptionsSchema>;

const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.unknown(),
        message: z.string(),
      })
      .optional(),
  })
  .passthrough();

function extractMcpArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.jams)) return record.jams;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (
        item &&
        typeof item === "object" &&
        "type" in item &&
        (item as { type: string }).type === "text" &&
        "text" in item &&
        typeof (item as { text: string }).text === "string"
      ) {
        try {
          const parsed = JSON.parse((item as { text: string }).text);
          const extracted = extractMcpArray(parsed);
          if (extracted.length > 0) return extracted;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return [parsed];
          }
        } catch {
          // Not JSON; continue to next content block.
        }
      }
    }
  }
  return [];
}

function extractMcpNextCursor(
  result: unknown,
  lastItem?: unknown
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.next === "string") return record.next;
  if (typeof record.nextCursor === "string") return record.nextCursor;
  if (typeof record.after === "string") return record.after;
  if (lastItem && typeof lastItem === "object" && lastItem !== null) {
    const item = lastItem as Record<string, unknown>;
    if (typeof item.id === "string") return item.id;
    if (typeof item.jamId === "string") return item.jamId;
  }
  return undefined;
}

function normalizeMcpJam(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { jamId: "unknown", jamUrl: "" };
  const item = raw as Record<string, unknown>;

  const jamId =
    typeof item.id === "string"
      ? item.id
      : typeof item.jamId === "string"
        ? item.jamId
        : typeof item.publicId === "string"
          ? item.publicId
          : "unknown";
  const jamUrl =
    typeof item.jamUrl === "string"
      ? item.jamUrl
      : typeof item.url === "string"
        ? item.url
        : typeof item.publicUrl === "string"
          ? item.publicUrl
          : "";

  const title = typeof item.title === "string" ? item.title : undefined;
  const description =
    typeof item.description === "string" ? item.description : undefined;
  const originalUrl =
    typeof item.originalUrl === "string" ? item.originalUrl : undefined;
  const origin = typeof item.origin === "string" ? item.origin : undefined;
  const teamId =
    typeof item.teamId === "string"
      ? item.teamId
      : typeof item.team_id === "string"
        ? item.team_id
        : undefined;

  let createdAt: string | undefined;
  if (typeof item.createdAt === "string") createdAt = item.createdAt;
  else if (typeof item.createdAt === "number")
    createdAt = new Date(item.createdAt * 1000).toISOString();
  else if (typeof item.created_at === "string") createdAt = item.created_at;
  else if (typeof item.created_at === "number")
    createdAt = new Date(item.created_at * 1000).toISOString();

  const author =
    item.author && typeof item.author === "object"
      ? (item.author as Record<string, unknown>)
      : undefined;
  const authorEmail =
    typeof author?.email === "string" ? author.email : undefined;
  const authorName = typeof author?.name === "string" ? author.name : undefined;

  const jamType =
    typeof item.type === "string"
      ? item.type
      : typeof item.jamType === "string"
        ? item.jamType
        : undefined;

  return {
    jamId,
    jamUrl,
    teamId,
    type: jamType,
    createdAt,
    title,
    description,
    originalUrl,
    origin,
    author:
      authorEmail || authorName
        ? { email: authorEmail, name: authorName }
        : undefined,
  };
}

async function jamMcpRequest(
  token: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
  const response = await fetch(JAM_MCP_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new VortexError({
      code: "BAD_REQUEST",
      status: response.status,
      message: `Jam MCP request failed: ${response.statusText}${text ? ` — ${text}` : ""}`,
    });
  }
  const raw = jsonRpcResponseSchema.safeParse(await response.json());
  if (!raw.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid Jam MCP response",
      hint: raw.error.message,
    });
  }
  if (raw.data.error) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: `Jam MCP error: ${raw.data.error.message}`,
    });
  }
  return raw.data.result;
}

async function listJamMcp(
  token: string,
  options: JamMcpSupportOptions,
  after?: string
): Promise<{ items: unknown[]; nextCursor?: string }> {
  const args: Record<string, unknown> = { limit: options.limit };
  if (after) args.after = after;
  if (options.text) args.text = options.text;
  if (options.type) args.type = options.type;
  if (options.folder) args.folder = options.folder;
  if (options.author) args.author = options.author;
  if (options.url) args.url = options.url;
  if (options.createdAt) args.createdAt = options.createdAt;

  const result = await jamMcpRequest(token, "listJams", args);
  const items = extractMcpArray(result);
  const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
  return {
    items,
    nextCursor: extractMcpNextCursor(result, lastItem),
  };
}

export const jamMcpSupportImportSource: ImportSource<
  JamMcpSupportCredentials,
  JamMcpSupportOptions
> = {
  name: "jam-mcp",

  async validate(credentials): Promise<ImportValidationResult> {
    const parsed = jamMcpSupportCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    try {
      await listJamMcp(parsed.data.token, { limit: 1 });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof VortexError
            ? error.message
            : "Jam MCP connection failed",
      };
    }
  },

  async run(
    ctx: ImportContext,
    credentials: JamMcpSupportCredentials,
    options: JamMcpSupportOptions,
    state?: ImportRunState
  ): Promise<ImportBatchResult> {
    const { token } = credentials;
    const parsedOptions = jamMcpSupportOptionsSchema.parse(options ?? {});
    const { items, nextCursor } = await listJamMcp(
      token,
      parsedOptions,
      state?.cursor ?? undefined
    );

    const data = items.map(normalizeMcpJam);
    const batch = await jamSupportImportSource.run(
      ctx,
      { data },
      { limit: data.length },
      undefined
    );

    return {
      counts: batch.counts,
      nextCursor: nextCursor ?? null,
    };
  },
};

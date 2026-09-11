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

function parseSseBody(text: string): unknown {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      try {
        return JSON.parse(data);
      } catch {
        // Continue to next data line.
      }
    }
  }
  throw new VortexError({
    code: "BAD_REQUEST",
    status: 500,
    message: "Invalid Jam MCP SSE response",
  });
}

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

  const result: Record<string, unknown> = {
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

  const detailFields = [
    "consoleLogs",
    "networkRequests",
    "userEvents",
    "systemInfo",
    "eventsSummary",
    "postprocessing",
    "metadata",
    "media",
  ];
  for (const key of detailFields) {
    if (key in item) result[key] = item[key];
  }

  return result;
}

function parseMcpToolText(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return undefined;
  }
  const record = result as { content?: unknown[] };
  for (const item of record.content ?? []) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type: string }).type === "text" &&
      "text" in item &&
      typeof (item as { text: string }).text === "string"
    ) {
      const text = (item as { text: string }).text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return undefined;
}

async function getJamMcpDetails(
  token: string,
  jamId: string
): Promise<Record<string, unknown>> {
  const [details, consoleLogs, networkRequests, userEvents, metadata] =
    await Promise.allSettled([
      jamMcpRequest(token, "getDetails", { jamId }),
      jamMcpRequest(token, "getConsoleLogs", { jamId }),
      jamMcpRequest(token, "getNetworkRequests", { jamId }),
      jamMcpRequest(token, "getUserEvents", { jamId }),
      jamMcpRequest(token, "getMetadata", { jamId }),
    ]);

  const result: Record<string, unknown> = {};

  const detailsData =
    details.status === "fulfilled"
      ? (parseMcpToolText(details.value) as Record<string, unknown> | undefined)
      : undefined;
  if (
    detailsData &&
    typeof detailsData === "object" &&
    !Array.isArray(detailsData)
  ) {
    if (
      typeof detailsData.description === "string" &&
      detailsData.description.length > 0
    ) {
      result.description = detailsData.description;
    }
    if (typeof detailsData.title === "string" && detailsData.title.length > 0) {
      result.title = detailsData.title;
    }
    if (detailsData.systemInfo) result.systemInfo = detailsData.systemInfo;
    if (detailsData.eventsSummary)
      result.eventsSummary = detailsData.eventsSummary;
    if (detailsData.postprocessing)
      result.postprocessing = detailsData.postprocessing;
    if (detailsData.metadata) result.metadata = detailsData.metadata;
  }

  function parseListResponse(
    res: PromiseSettledResult<unknown>,
    key: string
  ): void {
    if (res.status !== "fulfilled") return;
    const data = parseMcpToolText(res.value);
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Array.isArray((data as Record<string, unknown>).events)
    ) {
      result[key] = (data as Record<string, unknown>).events;
    }
  }

  parseListResponse(consoleLogs, "consoleLogs");
  parseListResponse(networkRequests, "networkRequests");
  parseListResponse(userEvents, "userEvents");

  const metadataData =
    metadata.status === "fulfilled"
      ? parseMcpToolText(metadata.value)
      : undefined;
  if (
    metadataData &&
    typeof metadataData === "object" &&
    !Array.isArray(metadataData) &&
    Object.keys(metadataData).length > 0
  ) {
    result.metadata = metadataData;
  }

  return result;
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
      Accept: "application/json, text/event-stream",
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
  const parsed = parseSseBody(await response.text());
  const raw = jsonRpcResponseSchema.safeParse(parsed);
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
  if (
    raw.data.result &&
    typeof raw.data.result === "object" &&
    !Array.isArray(raw.data.result) &&
    (raw.data.result as { isError?: boolean }).isError
  ) {
    const result = raw.data.result as {
      content?: { type: string; text: string }[];
    };
    const text =
      result.content?.map((c) => c.text).join("\n") ?? "Jam MCP tool error";
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: text,
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

    const detailed = await Promise.all(
      items.map(async (raw) => {
        const record =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {};
        const jamId =
          typeof record.id === "string"
            ? record.id
            : typeof record.jamId === "string"
              ? record.jamId
              : undefined;
        if (!jamId) return raw;
        const details = await getJamMcpDetails(token, jamId);
        return Object.assign({}, record, details);
      })
    );

    const data = detailed.map(normalizeMcpJam);
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

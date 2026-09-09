import { z } from "zod";

const notionApiBaseUrl = "https://api.notion.com/v1";
const notionApiVersion = "2026-03-11";

class NotionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

async function notionRequest<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  parser: (value: unknown) => T = (value) => value as T
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": notionApiVersion,
    "Content-Type": "application/json",
  };
  const res = await fetch(`${notionApiBaseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new NotionApiError(
      `Notion API ${method} ${path} failed with ${res.status}`,
      res.status
    );
  }
  const json = (await res.json()) as unknown;
  return parser(json);
}

const notionUserMeSchema = z.object({
  object: z.literal("user"),
  id: z.string(),
  type: z.string().optional(),
  bot: z
    .object({
      owner: z
        .object({
          type: z.string().optional(),
          workspace: z.union([z.boolean(), z.object({})]).optional(),
        })
        .optional(),
      workspace_name: z.string().optional(),
      workspace_id: z.string().optional(),
    })
    .optional(),
});

export type NotionWorkspaceInfo = {
  workspaceId: string;
  workspaceName: string | null;
  botId: string;
};

export async function getNotionWorkspaceInfo(
  token: string
): Promise<NotionWorkspaceInfo> {
  const data = await notionRequest(
    token,
    "GET",
    "/users/me",
    undefined,
    (value) => {
      const parsed = notionUserMeSchema.safeParse(value);
      if (!parsed.success) {
        throw new NotionApiError("Invalid Notion users/me response", 500);
      }
      return parsed.data;
    }
  );
  const workspaceId = data.bot?.workspace_id;
  if (!workspaceId) {
    throw new NotionApiError("Notion token is not associated with a workspace", 400);
  }
  return {
    workspaceId,
    workspaceName: data.bot?.workspace_name ?? null,
    botId: data.id,
  };
}

const emojiIconSchema = z.object({
  type: z.literal("emoji"),
  emoji: z.string(),
});

const notionParentSchema = z.object({
  type: z.string(),
  page_id: z.string().optional(),
  workspace: z.boolean().optional(),
});

const notionUserReferenceSchema = z.object({
  object: z.string().optional(),
  id: z.string(),
});

const notionPageSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().optional(),
  icon: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  parent: z.unknown().optional(),
  created_by: z.unknown().optional(),
  last_edited_by: z.unknown().optional(),
});

export type NotionPage = {
  id: string;
  url: string;
  icon: string | null;
  title: string;
  parentType: string;
  parentPageId: string | null;
  createdById: string | null;
  lastEditedById: string | null;
};

function extractTitle(properties: unknown): string {
  const record =
    typeof properties === "object" && properties !== null
      ? (properties as Record<string, unknown>)
      : {};
  const titleProperty = record.title;
  const titleArray =
    Array.isArray(titleArraySchema.safeParse(titleProperty).data?.title)
      ? titleProperty
      : null;
  if (titleArray && Array.isArray(titleArray)) {
    const texts = titleArray
      .map((item) => {
        const parsed = plainTextSchema.safeParse(item);
        return parsed.success ? parsed.data.plain_text : "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("");
  }
  return "Untitled";
}

const titleArraySchema = z.object({
  title: z.array(z.unknown()),
});

const plainTextSchema = z.object({ plain_text: z.string() });

function extractIcon(icon: unknown): string | null {
  const parsed = emojiIconSchema.safeParse(icon);
  return parsed.success ? parsed.data.emoji : null;
}

function extractUserId(value: unknown): string | null {
  const parsed = notionUserReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data.id : null;
}

function extractParent(value: unknown): {
  type: string;
  pageId: string | null;
} {
  const parsed = notionParentSchema.safeParse(value);
  if (!parsed.success) return { type: "unknown", pageId: null };
  return {
    type: parsed.data.type,
    pageId: parsed.data.page_id ?? null,
  };
}

export async function getNotionPage(
  token: string,
  pageId: string
): Promise<NotionPage> {
  const raw = await notionRequest(
    token,
    "GET",
    `/pages/${encodeURIComponent(pageId)}`,
    undefined,
    (value) => {
      const parsed = notionPageSchema.safeParse(value);
      if (!parsed.success) {
        throw new NotionApiError("Invalid Notion page response", 500);
      }
      return parsed.data;
    }
  );
  const parent = extractParent(raw.parent);
  return {
    id: raw.id,
    url: raw.url ?? `https://www.notion.so/${raw.id.replace(/-/g, "")}`,
    icon: extractIcon(raw.icon),
    title: extractTitle(raw.properties),
    parentType: parent.type,
    parentPageId: parent.pageId,
    createdById: extractUserId(raw.created_by),
    lastEditedById: extractUserId(raw.last_edited_by),
  };
}

const notionPageMarkdownSchema = z.object({
  object: z.literal("page_markdown"),
  id: z.string(),
  markdown: z.string(),
  truncated: z.boolean().optional(),
});

export async function getNotionPageMarkdown(
  token: string,
  pageId: string
): Promise<string> {
  const data = await notionRequest(
    token,
    "GET",
    `/pages/${encodeURIComponent(pageId)}/markdown`,
    undefined,
    (value) => {
      const parsed = notionPageMarkdownSchema.safeParse(value);
      if (!parsed.success) {
        throw new NotionApiError("Invalid Notion page markdown response", 500);
      }
      return parsed.data;
    }
  );
  return data.markdown;
}

const notionSearchResultSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().optional(),
  icon: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  parent: z.unknown().optional(),
});

const notionSearchResponseSchema = z.object({
  object: z.literal("list"),
  results: z.array(notionSearchResultSchema),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
});

export type NotionSearchPage = {
  id: string;
  url: string;
  icon: string | null;
  title: string;
  parentType: string;
  parentPageId: string | null;
};

export async function searchNotionPages(
  token: string,
  cursor?: string | null
): Promise<{ pages: NotionSearchPage[]; nextCursor: string | null }> {
  const data = await notionRequest(
    token,
    "POST",
    "/search",
    {
      filter: { value: "page", property: "object" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    },
    (value) => {
      const parsed = notionSearchResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new NotionApiError("Invalid Notion search response", 500);
      }
      return parsed.data;
    }
  );
  const pages = data.results.map((result) => {
    const parent = extractParent(result.parent);
    return {
      id: result.id,
      url: result.url ?? `https://www.notion.so/${result.id.replace(/-/g, "")}`,
      icon: extractIcon(result.icon),
      title: extractTitle(result.properties),
      parentType: parent.type,
      parentPageId: parent.pageId,
    };
  });
  return { pages, nextCursor: data.next_cursor ?? null };
}

export { NotionApiError };

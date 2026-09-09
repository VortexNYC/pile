import { z } from "zod";

import { adfToMarkdown } from "../global/adf-to-markdown.js";
import { VortexError } from "../platform/errors.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";
import { getOrCreateUser } from "./users.js";
import { unwrap } from "./utils.js";

export const confluenceCredentialsSchema = z.object({
  host: z.string().url(),
  email: z.string().email(),
  token: z.string().min(1),
});

export type ConfluenceCredentials = z.infer<typeof confluenceCredentialsSchema>;

export const confluenceOptionsSchema = z.object({
  spaceKey: z.string().optional(),
  rootPageId: z.string().optional(),
});

export type ConfluenceOptions = z.infer<typeof confluenceOptionsSchema>;

interface ConfluenceApi {
  host: string;
  auth: string;
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
}

const confluencePageSchema = z.object({
  id: z.string(),
  status: z.string(),
  title: z.string(),
  spaceId: z.string(),
  parentId: z.string().optional(),
  parentType: z.string().optional(),
  authorId: z.string().optional(),
  ownerId: z.string().optional(),
  createdAt: z.string(),
  version: z
    .object({
      createdAt: z.string(),
      authorId: z.string().optional(),
    })
    .optional(),
  body: z
    .object({
      atlas_doc_format: z
        .object({
          value: z.string(),
        })
        .optional(),
    })
    .optional(),
});

const confluenceSpaceSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

const confluenceUserSchema = z.object({
  accountId: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
});

function makeClient(credentials: ConfluenceCredentials): ConfluenceApi {
  const host = credentials.host.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;

  async function request(
    path: string,
    query?: Record<string, string>
  ): Promise<unknown> {
    const url = new URL(path, host);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: auth,
        Accept: "application/json",
      },
    });
    const detail = await res.text().catch(() => "");
    if (!res.ok) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Confluence API error: ${res.status} ${detail.slice(0, 500)}`,
      });
    }
    if (res.status === 204 || detail === "") return {};
    try {
      return JSON.parse(detail);
    } catch {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Confluence API returned invalid JSON",
      });
    }
  }

  return {
    host,
    auth,
    get: (path, query) => request(path, query),
  };
}

function parseAdfValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function resolveConfluenceUser(
  ctx: ImportContext,
  api: ConfluenceApi,
  cache: Map<string, string | null>,
  accountId: string | undefined
): Promise<string | null> {
  if (!accountId) return null;
  if (cache.has(accountId)) return cache.get(accountId) ?? null;

  const raw = await api.get("/wiki/rest/api/user", { accountId });
  const parsed = confluenceUserSchema.safeParse(raw);
  if (!parsed.success) {
    cache.set(accountId, null);
    return null;
  }

  const id = await getOrCreateUser(
    ctx,
    cache,
    parsed.data.accountId,
    parsed.data.email,
    parsed.data.displayName
  );
  cache.set(accountId, id);
  return id;
}

async function importPage(
  ctx: ImportContext,
  api: ConfluenceApi,
  userCache: Map<string, string | null>,
  confluencePage: z.infer<typeof confluencePageSchema>
): Promise<{
  confluencePageId: string;
  documentId: string;
  parentId?: string;
}> {
  const authorId = await resolveConfluenceUser(
    ctx,
    api,
    userCache,
    confluencePage.authorId ?? confluencePage.ownerId
  );
  const markdown = adfToMarkdown(
    parseAdfValue(confluencePage.body?.atlas_doc_format?.value ?? "")
  );

  const doc = await ctx.stub.createDocument({
    title: confluencePage.title,
    content: markdown,
    contentFormat: "markdown",
    createdById: authorId ?? ctx.importerId,
  });

  return {
    confluencePageId: confluencePage.id,
    documentId: unwrap(doc, "Failed to create document").id,
    parentId: confluencePage.parentId,
  };
}

async function listSpacePages(
  api: ConfluenceApi,
  spaceId: string
): Promise<z.infer<typeof confluencePageSchema>[]> {
  const pages: z.infer<typeof confluencePageSchema>[] = [];
  let cursor: string | undefined;
  do {
    const result = await api.get("/wiki/api/v2/pages", {
      "space-id": spaceId,
      "body-format": "atlas_doc_format",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const parsed = z
      .object({
        results: z.array(z.unknown()),
        _links: z.object({ next: z.string().optional() }).optional(),
      })
      .safeParse(result);
    if (!parsed.success) break;
    for (const raw of parsed.data.results) {
      const page = confluencePageSchema.safeParse(raw);
      if (page.success) pages.push(page.data);
    }
    const { _links: links } = parsed.data;
    const nextUrl = links?.next;
    cursor = nextUrl
      ? (new URL(nextUrl, api.host).searchParams.get("cursor") ?? undefined)
      : undefined;
  } while (cursor);
  return pages;
}

async function fetchPage(
  api: ConfluenceApi,
  pageId: string
): Promise<z.infer<typeof confluencePageSchema> | null> {
  const result = await api.get(`/wiki/api/v2/pages/${pageId}`, {
    "body-format": "atlas_doc_format",
  });
  const parsed = confluencePageSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

async function listChildPageIds(
  api: ConfluenceApi,
  pageId: string
): Promise<{ id: string; title: string }[]> {
  const result = await api.get(`/wiki/api/v2/pages/${pageId}/children`, {
    limit: "100",
  });
  const parsed = z
    .object({
      results: z.array(z.object({ id: z.string(), title: z.string() })),
      _links: z.object({ next: z.string().optional() }).optional(),
    })
    .safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.results;
}

async function collectRootSubtree(
  api: ConfluenceApi,
  rootPageId: string,
  collected: z.infer<typeof confluencePageSchema>[]
): Promise<void> {
  const root = await fetchPage(api, rootPageId);
  if (!root) return;
  collected.push(root);

  const queue = [rootPageId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    const children = await listChildPageIds(api, id);
    for (const child of children) {
      const childPage = await fetchPage(api, child.id);
      if (!childPage) continue;
      collected.push(childPage);
      queue.push(child.id);
    }
  }
}

export const confluenceImportSource: ImportSource<
  ConfluenceCredentials,
  ConfluenceOptions
> = {
  name: "confluence",

  validate(credentials): ImportValidationResult {
    const parsed = confluenceCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options): Promise<ImportBatchResult> {
    const parsedOptions = confluenceOptionsSchema.parse(options ?? {});
    if (!parsedOptions.spaceKey && !parsedOptions.rootPageId) {
      return { counts: { errors: 1 }, nextCursor: null };
    }

    const api = makeClient(credentials);
    const userCache = new Map<string, string | null>();
    const pages: z.infer<typeof confluencePageSchema>[] = [];

    if (parsedOptions.rootPageId) {
      await collectRootSubtree(api, parsedOptions.rootPageId, pages);
    }

    if (parsedOptions.spaceKey) {
      const spaceResult = await api.get(
        `/wiki/rest/api/space/${parsedOptions.spaceKey}`
      );
      const space = confluenceSpaceSchema.safeParse(spaceResult);
      if (!space.success) {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: `Confluence space ${parsedOptions.spaceKey} not found`,
        });
      }
      const spacePages = await listSpacePages(api, space.data.id);
      pages.push(...spacePages);
    }

    const imported = new Map<
      string,
      { documentId: string; parentId?: string }
    >();
    let createdCount = 0;
    let errorCount = 0;

    for (const page of pages) {
      try {
        const result = await importPage(ctx, api, userCache, page);
        imported.set(result.confluencePageId, result);
        createdCount++;
      } catch (err) {
        errorCount++;
        if (err instanceof Error) {
          console.error(
            `Failed to import Confluence page ${page.id}: ${err.message}`
          );
        }
      }
    }

    // Second pass: set parentDocumentId.
    let parentLinkedCount = 0;
    for (const [, result] of imported) {
      if (!result.parentId) continue;
      const parentDocumentId = imported.get(result.parentId)?.documentId;
      if (!parentDocumentId) continue;
      try {
        await ctx.stub.updateDocument(
          result.documentId,
          { parentDocumentId },
          ctx.importerId
        );
        parentLinkedCount++;
      } catch {
        // Ignore parent update failures.
      }
    }

    return {
      counts: {
        documents: createdCount,
        parentLinks: parentLinkedCount,
        errors: errorCount,
      },
      nextCursor: null,
    };
  },
};

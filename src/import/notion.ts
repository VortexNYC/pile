import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getNotionPage,
  getNotionPageMarkdown,
  getNotionWorkspaceInfo,
  NotionApiError,
  searchNotionPages,
  type NotionSearchPage,
} from "../global/notion-client.js";
import { upsertNotionInstallation } from "../global/notion-installations.js";
import {
  findNotionPageMapping,
  upsertNotionPageMapping,
} from "../global/notion-page-mappings.js";
import { findNotionUserByNotionId } from "../global/notion-users.js";
import { notionPageMappings } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type {
  ImportContext,
  ImportCounts,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

export const notionCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type NotionCredentials = z.infer<typeof notionCredentialsSchema>;

export const notionOptionsSchema = z.object({
  rootPageId: z.string().optional(),
  spaceId: z.string().optional(),
});

export type NotionOptions = z.infer<typeof notionOptionsSchema>;

export async function resolveNotionUserId(
  ctx: ImportContext,
  notionUserId: string | null,
  fallbackUserId: string
): Promise<string> {
  if (!notionUserId) return fallbackUserId;
  const mapping = await findNotionUserByNotionId(
    ctx.db,
    ctx.organizationId,
    notionUserId
  );
  return mapping?.userId ?? fallbackUserId;
}

export async function syncNotionPage(
  ctx: ImportContext,
  token: string,
  notionPage: NotionSearchPage,
  spaceId: string | null,
  parentDocumentId: string | null
): Promise<"created" | "updated"> {
  const [page, markdown] = await Promise.all([
    getNotionPage(token, notionPage.id),
    getNotionPageMarkdown(token, notionPage.id),
  ]);

  const actorId = await resolveNotionUserId(
    ctx,
    page.lastEditedById ?? page.createdById,
    ctx.importerId
  );

  const mapping = await findNotionPageMapping(
    ctx.db,
    ctx.organizationId,
    notionPage.id
  );

  let documentId: string;
  if (mapping) {
    const updated = await ctx.stub.updateDocument(
      mapping.documentId,
      {
        title: page.title,
        icon: page.icon,
        content: markdown,
        contentFormat: "markdown",
        parentDocumentId,
        spaceId,
      },
      actorId
    );
    if (!updated) {
      throw new Error("Failed to update document");
    }
    documentId = updated.id;
  } else {
    const createdById = await resolveNotionUserId(
      ctx,
      page.createdById,
      ctx.importerId
    );
    const created = await ctx.stub.createDocument({
      title: page.title,
      icon: page.icon,
      content: markdown,
      contentFormat: "markdown",
      parentDocumentId,
      spaceId,
      createdById,
    });
    documentId = created.id;
  }

  await upsertNotionPageMapping(
    ctx.db,
    ctx.organizationId,
    notionPage.id,
    documentId
  );

  return mapping ? "updated" : "created";
}

export const notionImportSource: ImportSource<
  NotionCredentials,
  NotionOptions
> = {
  name: "notion",

  validate(credentials): ImportValidationResult {
    const parsed = notionCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options): Promise<ImportCounts> {
    const parsedOptions = notionOptionsSchema.parse(options ?? {});
    const { token } = credentials;
    const { rootPageId, spaceId } = parsedOptions;

    let workspaceInfo;
    try {
      workspaceInfo = await getNotionWorkspaceInfo(token);
    } catch (err) {
      if (err instanceof NotionApiError) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: err.status,
          message: err.message,
        });
      }
      throw err;
    }

    await upsertNotionInstallation(
      ctx.db,
      ctx.organizationId,
      workspaceInfo.workspaceId,
      token
    );

    const pages: NotionSearchPage[] = [];

    if (rootPageId) {
      const page = await getNotionPage(token, rootPageId);
      pages.push({
        id: page.id,
        url: page.url,
        icon: page.icon,
        title: page.title,
        parentType: page.parentType,
        parentPageId: page.parentPageId,
      });
    } else {
      let cursor: string | null = null;
      do {
        const result = await searchNotionPages(token, cursor ?? undefined);
        pages.push(...result.pages);
        cursor = result.nextCursor;
      } while (cursor);
    }

    const parentByPageId = new Map<string, string | null>();

    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const page of pages) {
      try {
        const result = await syncNotionPage(
          ctx,
          token,
          page,
          spaceId ?? null,
          null
        );
        if (result === "created") created++;
        else updated++;
        parentByPageId.set(page.id, page.parentPageId);
      } catch {
        errors++;
      }
    }

    const mappings = await ctx.db
      .select({
        notionPageId: notionPageMappings.notionPageId,
        documentId: notionPageMappings.documentId,
      })
      .from(notionPageMappings)
      .where(eq(notionPageMappings.organizationId, ctx.organizationId))
      .all();
    const documentIdByNotionPageId = new Map(
      mappings.map((m) => [m.notionPageId, m.documentId])
    );

    for (const page of pages) {
      const documentId = documentIdByNotionPageId.get(page.id);
      const parentPageId = parentByPageId.get(page.id);
      if (!documentId || !parentPageId) continue;
      const parentDocumentId = documentIdByNotionPageId.get(parentPageId);
      if (!parentDocumentId) continue;
      try {
        await ctx.stub.updateDocument(
          documentId,
          { parentDocumentId },
          ctx.importerId
        );
      } catch {
        errors++;
      }
    }

    return {
      documents: created + updated,
      created,
      updated,
      errors,
    };
  },
};

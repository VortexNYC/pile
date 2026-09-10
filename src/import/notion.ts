import { z } from "zod";

import {
  recordImportParentLink,
  resolveImportParentLinks,
} from "../global/import-parent-links.js";
import {
  getNotionDatabase,
  getNotionPage,
  getNotionPageMarkdown,
  getNotionWorkspaceInfo,
  NotionApiError,
  queryNotionDatabase,
  searchNotionPages,
  type NotionSearchPage,
} from "../global/notion-client.js";
import { upsertNotionInstallation } from "../global/notion-installations.js";
import {
  findNotionIssueMapping,
  upsertNotionIssueMapping,
} from "../global/notion-issue-mappings.js";
import {
  findNotionPageMapping,
  upsertNotionPageMapping,
} from "../global/notion-page-mappings.js";
import { findNotionUserByNotionId } from "../global/notion-users.js";
import { VortexError } from "../platform/errors.js";
import type { IssueInput } from "../types/workspace.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportRunState,
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
  databaseId: z.string().optional(),
  teamId: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
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
): Promise<{ status: "created" | "updated"; documentId: string }> {
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

  return { status: mapping ? "updated" : "created", documentId };
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

  async run(
    ctx,
    credentials,
    options,
    runState?: ImportRunState
  ): Promise<ImportBatchResult> {
    const parsedOptions = notionOptionsSchema.parse(options ?? {});
    const { token } = credentials;
    const { rootPageId, spaceId, databaseId, teamId } = parsedOptions;

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

    if (databaseId) {
      return importNotionDatabase(ctx, token, databaseId, teamId, runState);
    }

    const limit = runState?.limit ?? parsedOptions.limit;
    let startCursor = runState?.cursor ?? parsedOptions.cursor ?? null;
    let nextCursor: string | null = null;

    let created = 0;
    let updated = 0;
    let errors = 0;
    let processed = 0;
    let searchComplete = false;

    if (rootPageId) {
      const page = await getNotionPage(token, rootPageId);
      try {
        const parentDocumentId = page.parentPageId
          ? ((
              await findNotionPageMapping(
                ctx.db,
                ctx.organizationId,
                page.parentPageId
              )
            )?.documentId ?? null)
          : null;
        const { status, documentId } = await syncNotionPage(
          ctx,
          token,
          {
            id: page.id,
            url: page.url,
            icon: page.icon,
            title: page.title,
            parentType: page.parentType,
            parentPageId: page.parentPageId,
          },
          spaceId ?? null,
          parentDocumentId
        );
        if (status === "created") created++;
        else updated++;
        if (page.parentPageId) {
          await recordImportParentLink(
            ctx.db,
            ctx.organizationId,
            ctx.jobId,
            documentId,
            page.parentPageId
          );
        }
      } catch {
        errors++;
      }
      searchComplete = true;
    } else {
      let keepGoing = true;
      do {
        const remaining = limit ? limit - processed : undefined;
        const pageSize = remaining ? Math.min(100, remaining) : 100;
        const result = await searchNotionPages(
          token,
          startCursor ?? undefined,
          pageSize
        );
        for (const page of result.pages) {
          try {
            const parentDocumentId = page.parentPageId
              ? ((
                  await findNotionPageMapping(
                    ctx.db,
                    ctx.organizationId,
                    page.parentPageId
                  )
                )?.documentId ?? null)
              : null;
            const { status, documentId } = await syncNotionPage(
              ctx,
              token,
              page,
              spaceId ?? null,
              parentDocumentId
            );
            if (status === "created") created++;
            else updated++;
            if (page.parentPageId) {
              await recordImportParentLink(
                ctx.db,
                ctx.organizationId,
                ctx.jobId,
                documentId,
                page.parentPageId
              );
            }
          } catch {
            errors++;
          }
        }
        processed += result.pages.length;
        nextCursor = result.nextCursor;
        startCursor = nextCursor;
        keepGoing =
          startCursor !== null && (limit === undefined || processed < limit);
      } while (keepGoing);

      searchComplete = !startCursor;
    }

    if (searchComplete) {
      await resolveImportParentLinks(
        ctx.db,
        ctx.jobId,
        async (parentExternalId) => {
          const mapping = await findNotionPageMapping(
            ctx.db,
            ctx.organizationId,
            parentExternalId
          );
          return mapping?.documentId ?? undefined;
        },
        async (childId, parentDocumentId) => {
          await ctx.stub.updateDocument(
            childId,
            { parentDocumentId },
            ctx.importerId
          );
        }
      );
    }

    return {
      counts: {
        documents: created + updated,
        created,
        updated,
        errors,
      },
      nextCursor,
    };
  },
};

async function importNotionDatabase(
  ctx: ImportContext,
  token: string,
  databaseId: string,
  teamId: string | undefined,
  runState?: ImportRunState
): Promise<ImportBatchResult> {
  const database = await getNotionDatabase(token, databaseId);

  const limit = runState?.limit;
  let startCursor = runState?.cursor ?? null;
  let nextCursor: string | null = null;

  let created = 0;
  let updated = 0;
  let errors = 0;
  let processed = 0;

  let keepGoing = true;
  do {
    const remaining = limit ? limit - processed : undefined;
    const pageSize = remaining ? Math.min(100, remaining) : 100;
    const result = await queryNotionDatabase(
      token,
      databaseId,
      database.titlePropertyName,
      startCursor ?? undefined,
      pageSize
    );

    for (const row of result.rows) {
      try {
        const markdown = await getNotionPageMarkdown(token, row.id);
        const actorId = await resolveNotionUserId(
          ctx,
          row.lastEditedById ?? row.createdById,
          ctx.importerId
        );
        const mapping = await findNotionIssueMapping(
          ctx.db,
          ctx.organizationId,
          row.id
        );

        if (mapping) {
          await ctx.stub.updateIssue(
            mapping.issueId,
            { title: row.title, description: markdown },
            actorId
          );
          updated++;
        } else {
          const issueInput: IssueInput = {
            title: row.title,
            description: markdown,
            teamId,
          };
          const issue = await ctx.stub.createIssue(issueInput, actorId);
          await upsertNotionIssueMapping(
            ctx.db,
            ctx.organizationId,
            row.id,
            issue.id
          );
          created++;
        }
      } catch {
        errors++;
      }
    }

    processed += result.rows.length;
    nextCursor = result.nextCursor;
    startCursor = nextCursor;
    keepGoing =
      startCursor !== null && (limit === undefined || processed < limit);
  } while (keepGoing);

  return {
    counts: {
      issues: created + updated,
      created,
      updated,
      errors,
    },
    nextCursor,
  };
}

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { adfToMarkdown } from "../global/adf-to-markdown.js";
import { labels, projects, states } from "../global/schema.js";
import {
  createLabel,
  createProject,
  createState,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type {
  IssueInput,
  IssuePriority,
  IssueStatus,
} from "../types/workspace.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportSource,
  ImportValidationResult,
} from "./types.js";
import { getOrCreateUser } from "./users.js";
import { unwrap } from "./utils.js";

export const jiraCredentialsSchema = z.object({
  host: z.string().url(),
  email: z.string().email(),
  token: z.string().min(1),
});

export type JiraCredentials = z.infer<typeof jiraCredentialsSchema>;

export const jiraOptionsSchema = z.object({
  projectKey: z.string().optional(),
  jql: z.string().optional(),
});

export type JiraOptions = z.infer<typeof jiraOptionsSchema>;

interface JiraApi {
  host: string;
  auth: string;
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  raw: (url: string) => Promise<Response>;
}

const jiraUserSchema = z.object({
  accountId: z.string(),
  emailAddress: z.string().optional(),
  displayName: z.string().optional(),
});

const jiraStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  statusCategory: z
    .object({
      key: z.string(),
      name: z.string(),
    })
    .optional(),
});

const jiraProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

const jiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

const jiraSearchResponseSchema = z.object({
  issues: z.array(z.unknown()),
  nextPageToken: z.string().optional(),
});

const jiraAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string().optional(),
  created: z.string().optional(),
});

const jiraCommentSchema = z.object({
  id: z.string(),
  body: z.unknown(),
  author: z
    .object({
      accountId: z.string(),
      emailAddress: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
  created: z.string(),
  updated: z.string(),
});

function makeClient(credentials: JiraCredentials): JiraApi {
  const host = credentials.host.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;

  async function request(
    method: "GET" | "POST",
    path: string,
    bodyOrQuery?: unknown
  ): Promise<unknown> {
    const url = new URL(path, host);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };
    if (method === "GET" && bodyOrQuery && typeof bodyOrQuery === "object") {
      for (const [key, value] of Object.entries(
        bodyOrQuery as Record<string, string>
      )) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    } else if (method === "POST" && bodyOrQuery) {
      init.body = JSON.stringify(bodyOrQuery);
    }
    const res = await fetch(url.toString(), init);
    const detail = await res.text().catch(() => "");
    if (!res.ok) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Jira API error: ${res.status} ${detail.slice(0, 500)}`,
      });
    }
    if (res.status === 204 || detail === "") return {};
    try {
      return JSON.parse(detail);
    } catch {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Jira API returned invalid JSON",
      });
    }
  }

  return {
    host,
    auth,
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, body),
    raw: (url) =>
      fetch(url, {
        headers: { Authorization: auth },
      }),
  };
}

function mapStatus(
  status: z.infer<typeof jiraStatusSchema>
): IssueStatus | undefined {
  const name = status.name.toLowerCase();
  if (
    name.includes("canceled") ||
    name.includes("cancelled") ||
    name.includes("wont") ||
    name.includes("won't")
  ) {
    return "canceled";
  }
  if (name.includes("triage")) return "triage";
  if (name.includes("backlog")) return "backlog";
  if (
    name.includes("todo") ||
    name.includes("to do") ||
    name.includes("open") ||
    name.includes("new")
  )
    return "todo";
  if (
    name.includes("progress") ||
    name.includes("in progress") ||
    name.includes("started")
  )
    return "in_progress";
  if (
    name.includes("done") ||
    name.includes("closed") ||
    name.includes("resolved") ||
    name.includes("complete")
  ) {
    return "done";
  }

  const category = status.statusCategory?.key?.toLowerCase();
  if (category === "done") return "done";
  if (category === "indeterminate") return "in_progress";
  if (category === "new") return "todo";
  return undefined;
}

function mapPriority(priority: unknown): IssuePriority | undefined {
  if (typeof priority === "string") {
    const name = priority.toLowerCase();
    if (name.includes("highest")) return "urgent";
    if (name.includes("high")) return "high";
    if (name.includes("medium") || name.includes("normal")) return "medium";
    if (name.includes("low")) return "low";
    return undefined;
  }
  if (priority && typeof priority === "object") {
    const parsed = z.object({ name: z.string() }).safeParse(priority);
    if (parsed.success) return mapPriority(parsed.data.name);
  }
  return undefined;
}

async function getOrCreateLabel(
  ctx: ImportContext,
  cache: Map<string, string>,
  name: string
): Promise<string> {
  if (cache.has(name)) return cache.get(name) ?? "";
  const existing = await ctx.db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(eq(labels.organizationId, ctx.organizationId), eq(labels.name, name))
    )
    .get();
  if (existing) {
    cache.set(name, existing.id);
    return existing.id;
  }
  const created = unwrap(
    await createLabel(ctx.db, ctx.organizationId, { name }),
    "Failed to create label"
  );
  cache.set(name, created.id);
  return created.id;
}

async function getOrCreateProject(
  ctx: ImportContext,
  cache: Map<string, string>,
  key: string,
  name: string
): Promise<string> {
  if (cache.has(key)) return cache.get(key) ?? "";
  const existing = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, ctx.organizationId),
        eq(projects.name, name)
      )
    )
    .get();
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }
  const created = unwrap(
    await createProject(ctx.db, ctx.organizationId, { name }),
    "Failed to create project"
  );
  cache.set(key, created.id);
  return created.id;
}

async function getOrCreateState(
  ctx: ImportContext,
  cache: Map<string, string>,
  status: z.infer<typeof jiraStatusSchema>
): Promise<string> {
  if (cache.has(status.id)) return cache.get(status.id) ?? "";
  const mapped = mapStatus(status);
  if (!mapped) {
    cache.set(status.id, "");
    return "";
  }
  const existing = await ctx.db
    .select({ id: states.id })
    .from(states)
    .where(
      and(
        eq(states.organizationId, ctx.organizationId),
        eq(states.linearId, status.id)
      )
    )
    .get();
  if (existing) {
    cache.set(status.id, existing.id);
    return existing.id;
  }
  const created = unwrap(
    await createState(ctx.db, ctx.organizationId, {
      linearId: status.id,
      name: status.name,
      type: mapped,
    }),
    "Failed to create state"
  );
  cache.set(status.id, created.id);
  return created.id;
}

function extractField<T>(
  fields: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>
): T | undefined {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function jiraField<T>(
  issue: z.infer<typeof jiraIssueSchema>,
  key: string,
  schema: z.ZodType<T>
): T | undefined {
  return extractField(issue.fields, key, schema);
}

function jiraDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return value;
  }
}

async function importComments(
  ctx: ImportContext,
  issueId: string,
  comments: z.infer<typeof jiraCommentSchema>[],
  userCache: Map<string, string | null>
): Promise<number> {
  let count = 0;
  for (const comment of comments) {
    const authorId = await getOrCreateUser(
      ctx,
      userCache,
      comment.author?.accountId,
      comment.author?.emailAddress,
      comment.author?.displayName
    );
    await ctx.stub.createComment({
      issueId,
      authorId,
      body: adfToMarkdown(comment.body),
      externalAuthor: comment.author?.displayName ?? undefined,
      externalSource: "jira",
      externalId: comment.id,
      createdAt: jiraDate(comment.created),
      updatedAt: jiraDate(comment.updated),
    });
    count++;
  }
  return count;
}

async function importAttachments(
  ctx: ImportContext,
  issueId: string,
  host: string,
  attachments: z.infer<typeof jiraAttachmentSchema>[],
  api: JiraApi
): Promise<number> {
  let count = 0;
  for (const attachment of attachments) {
    const url = `${host}/rest/api/3/attachment/content/${attachment.id}`;
    const created = await ctx.stub.createAttachment({
      issueId,
      linearId: attachment.id,
      url,
      title: attachment.filename,
      subtitle: attachment.contentType ?? null,
      createdAt: jiraDate(attachment.created),
    });
    if (!created) continue;
    count++;

    if (ctx.env.ATTACHMENTS_BUCKET) {
      const dl = await api.raw(url);
      const ct = dl.headers.get("Content-Type") ?? "";
      if (dl.body && ct && !ct.includes("text/html")) {
        const r2Key = `attachments/${ctx.organizationId}/${issueId}/${created.id}`;
        await ctx.env.ATTACHMENTS_BUCKET.put(r2Key, dl.body, {
          httpMetadata: { contentType: ct },
        });
        await ctx.stub.setAttachmentR2Key(created.id, r2Key);
      }
    }
  }
  return count;
}

export const jiraImportSource: ImportSource<JiraCredentials, JiraOptions> = {
  name: "jira",

  validate(credentials): ImportValidationResult {
    const parsed = jiraCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options): Promise<ImportBatchResult> {
    const parsedOptions = jiraOptionsSchema.parse(options ?? {});
    const projectKey = parsedOptions.projectKey;
    const customJql = parsedOptions.jql;

    if (!projectKey && !customJql) {
      return { counts: { errors: 1 }, nextCursor: null };
    }

    const jql = customJql ?? `project = ${projectKey}`;
    const api = makeClient(credentials);

    const myself = await api.get("/rest/api/3/myself");
    const userResult = jiraUserSchema.safeParse(myself);
    if (!userResult.success) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Jira authentication failed: invalid /myself response",
      });
    }

    const userCache = new Map<string, string | null>();
    const labelCache = new Map<string, string>();
    const projectCache = new Map<string, string>();
    const stateCache = new Map<string, string>();
    const issueIdByJiraId = new Map<string, string>();
    const parentLinks = new Map<string, string>();

    let issueCount = 0;
    let commentCount = 0;
    let attachmentCount = 0;
    let pageCount = 0;
    let nextPageToken: string | undefined;

    const fields = [
      "summary",
      "description",
      "status",
      "priority",
      "assignee",
      "reporter",
      "labels",
      "issuetype",
      "created",
      "updated",
      "comment",
      "attachment",
      "parent",
      "subtasks",
      "project",
    ];

    do {
      pageCount++;
      const result = await api.post("/rest/api/3/search/jql", {
        jql,
        maxResults: 100,
        fields,
        nextPageToken,
      });
      const parsed = jiraSearchResponseSchema.safeParse(result);
      if (!parsed.success) {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: "Jira search returned unexpected response",
        });
      }
      nextPageToken = parsed.data.nextPageToken;

      for (const rawIssue of parsed.data.issues) {
        const issueResult = jiraIssueSchema.safeParse(rawIssue);
        if (!issueResult.success) continue;
        const issue = issueResult.data;

        const status = jiraField(issue, "status", jiraStatusSchema);
        const priority = jiraField(
          issue,
          "priority",
          z.object({ name: z.string() })
        );
        const assignee = jiraField(issue, "assignee", jiraUserSchema);
        const project = jiraField(issue, "project", jiraProjectSchema);
        const labelNames =
          jiraField(issue, "labels", z.array(z.string())) ?? [];
        const issueType = jiraField(
          issue,
          "issuetype",
          z.object({ name: z.string() })
        );
        const comments = jiraField(
          issue,
          "comment",
          z.object({ comments: z.array(jiraCommentSchema) })
        );
        const attachments = jiraField(
          issue,
          "attachment",
          z.array(jiraAttachmentSchema)
        );
        const parent = jiraField(issue, "parent", z.object({ id: z.string() }));
        const created = jiraDate(issue.fields.created);
        const updated = jiraDate(issue.fields.updated);

        if (status) await getOrCreateState(ctx, stateCache, status);

        const assigneeId = await getOrCreateUser(
          ctx,
          userCache,
          assignee?.accountId,
          assignee?.emailAddress,
          assignee?.displayName
        );

        const allLabels = [...labelNames];
        if (issueType?.name) allLabels.push(`jira-type:${issueType.name}`);
        const labelIds =
          (
            await Promise.all(
              allLabels.map((name) => getOrCreateLabel(ctx, labelCache, name))
            )
          ).join(",") || undefined;

        let projectId: string | undefined;
        if (project) {
          projectId = await getOrCreateProject(
            ctx,
            projectCache,
            project.key,
            project.name
          );
        }

        const input: IssueInput = {
          id: issue.id,
          title: extractField(issue.fields, "summary", z.string()) ?? issue.key,
          description: adfToMarkdown(issue.fields.description),
          status: status ? mapStatus(status) : undefined,
          priority: priority ? mapPriority(priority.name) : undefined,
          assigneeId: assigneeId ?? undefined,
          labelIds,
          projectId,
          createdAt: created,
          updatedAt: updated,
        };

        try {
          const createdIssue = await ctx.stub.createIssue(
            input,
            ctx.importerId
          );
          issueCount++;
          issueIdByJiraId.set(issue.id, createdIssue.id);
          if (parent?.id) {
            parentLinks.set(createdIssue.id, parent.id);
          }

          if (comments && comments.comments.length > 0) {
            commentCount += await importComments(
              ctx,
              createdIssue.id,
              comments.comments,
              userCache
            );
          }
          if (attachments && attachments.length > 0) {
            attachmentCount += await importAttachments(
              ctx,
              createdIssue.id,
              api.host,
              attachments,
              api
            );
          }
        } catch (err) {
          // Continue importing other issues; count the failure later.
          if (err instanceof Error) {
            console.error(
              `Failed to import Jira issue ${issue.key}: ${err.message}`
            );
          }
        }
      }
    } while (nextPageToken);

    // Second pass: resolve parent links.
    let parentLinkedCount = 0;
    for (const [issueId, parentJiraId] of parentLinks) {
      const parentIssueId = issueIdByJiraId.get(parentJiraId);
      if (!parentIssueId) continue;
      try {
        await ctx.stub.updateIssue(
          issueId,
          { parentId: parentIssueId },
          ctx.importerId
        );
        parentLinkedCount++;
      } catch {
        // Ignore parent update failures.
      }
    }

    return {
      counts: {
        issues: issueCount,
        comments: commentCount,
        attachments: attachmentCount,
        parentLinks: parentLinkedCount,
        pages: pageCount,
      },
      nextCursor: null,
    };
  },
};

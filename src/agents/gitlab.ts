import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { getWorkspaceStub } from "../api/stub.js";
import { timingSafeEqualHex } from "../global/crypto.js";
import { findOrCreateCycleByName } from "../global/cycles.js";
import { createD1, type D1Client } from "../global/db.js";
import { findGitlabInstallationByProjectPath } from "../global/gitlab-installations.js";
import { findUserByGitlabUsername } from "../global/gitlab-users.js";
import { findLabelsByWorkspaceAndNames } from "../global/labels.js";
import {
  createRepoIssue,
  deleteRepoIssue,
  findRepoIssue,
} from "../global/repo-issues.js";
import { enqueueWebhook, scopedDeliveryId } from "../global/webhook-queue.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import type { IssueInput } from "../types/workspace.js";

const gitlabProjectSchema = z.object({
  id: z.union([z.string(), z.number()]),
  path_with_namespace: z.string(),
});

const gitlabIssueAttributesSchema = z.object({
  id: z.union([z.string(), z.number()]),
  iid: z.number().int(),
  title: z.string(),
  description: z.string().nullable().default(null),
  state: z.string(),
  action: z.string(),
  url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  assignees: z
    .array(
      z.object({
        username: z.string(),
      })
    )
    .default([]),
  labels: z
    .array(
      z.object({
        title: z.string().optional(),
        name: z.string().optional(),
      })
    )
    .default([]),
  milestone: z
    .object({
      title: z.string(),
    })
    .nullable()
    .default(null),
});

const gitlabIssuePayloadSchema = z.object({
  object_kind: z.literal("issue"),
  event_type: z.string().default("issue"),
  project: gitlabProjectSchema,
  object_attributes: gitlabIssueAttributesSchema,
});

const gitlabNoteAttributesSchema = z.object({
  id: z.union([z.string(), z.number()]),
  note: z.string(),
  noteable_type: z.string(),
  noteable_id: z.union([z.string(), z.number()]),
  created_at: z.string(),
  updated_at: z.string(),
  action: z.string().default("created"),
  position: z
    .object({
      new_path: z.string().optional(),
      old_path: z.string().optional(),
    })
    .optional(),
});

const gitlabNoteAuthorSchema = z.object({
  username: z.string(),
  name: z.string().default(""),
});

const gitlabNoteIssueSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
});

const gitlabNoteMergeRequestSchema = z.object({
  iid: z.number().int(),
  source_branch: z.string(),
  source: gitlabProjectSchema.optional(),
  target: gitlabProjectSchema.optional(),
});

const gitlabNotePayloadSchema = z.object({
  object_kind: z.literal("note"),
  event_type: z.string().default("note"),
  project: gitlabProjectSchema,
  object_attributes: gitlabNoteAttributesSchema,
  issue: gitlabNoteIssueSchema.optional(),
  merge_request: gitlabNoteMergeRequestSchema.optional(),
  author: gitlabNoteAuthorSchema,
});

const gitlabMergeRequestAttributesSchema = z.object({
  id: z.union([z.string(), z.number()]),
  iid: z.number().int(),
  title: z.string(),
  description: z.string().nullable().default(null),
  state: z.string(),
  action: z.string(),
  draft: z.boolean().default(false),
  work_in_progress: z.boolean().default(false),
  source_branch: z.string(),
  target_branch: z.string(),
  url: z.string(),
  source: gitlabProjectSchema.optional(),
  target: gitlabProjectSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

const gitlabMergeRequestPayloadSchema = z.object({
  object_kind: z.literal("merge_request"),
  event_type: z.string().default("merge_request"),
  project: gitlabProjectSchema,
  object_attributes: gitlabMergeRequestAttributesSchema,
  author: gitlabNoteAuthorSchema.optional(),
});

const gitlabWebhookPayloadSchema = z.union([
  gitlabIssuePayloadSchema,
  gitlabNotePayloadSchema,
  gitlabMergeRequestPayloadSchema,
]);

export const gitlabWebhookRoute = createRoute({
  method: "post",
  path: "/gitlab",
  tags: ["gitlab"],
  responses: {
    200: {
      description: "Webhook processed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
});

function gitlabStatusFromState(
  state: string,
  action: string
): IssueInput["status"] | undefined {
  if (state === "closed" || action === "close") return "canceled";
  if (action === "reopen") return "todo";
  if (action === "open") return "backlog";
  return undefined;
}

function parseIssueIdentifiers(text: string) {
  const regex = /\b([A-Za-z][A-Za-z0-9_-]*-\d+)\b/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
}

function gitlabPrStateFromAttributes(
  attrs: z.infer<typeof gitlabMergeRequestAttributesSchema>
): string {
  if (attrs.draft || attrs.work_in_progress) return "draft";
  if (attrs.state === "merged") return "merged";
  if (attrs.state === "closed") return "closed";
  return "open";
}

async function resolveGitlabInstallation(
  db: D1Client,
  envToken: string | undefined,
  projectPath: string,
  providedToken: string
) {
  const installation = await findGitlabInstallationByProjectPath(
    db,
    projectPath
  );
  const expected = installation?.webhookSecret ?? envToken ?? "";
  if (!expected) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "GitLab webhook secret not configured",
    });
  }
  if (!timingSafeEqualHex(providedToken, expected)) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid GitLab token",
    });
  }
  return installation;
}

const gitlabQueuePayloadSchema = z.object({
  organizationId: z.string(),
  rawBody: z.string(),
});

function extractGitlabDeliveryId(
  headers: Headers,
  rawBody: string,
  organizationId: string
): string {
  const headerId =
    headers.get("webhook-id") ??
    headers.get("Idempotency-Key") ??
    headers.get("X-Gitlab-Event-UUID");
  if (headerId) {
    return scopedDeliveryId("gitlab", organizationId, headerId);
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const data = gitlabWebhookPayloadSchema.safeParse(parsed);
    if (data.success) {
      const attrs = data.data.object_attributes;
      const kind =
        data.data.object_kind === "note" &&
        data.data.object_attributes.noteable_type === "MergeRequest"
          ? "mr_note"
          : data.data.object_kind;
      return scopedDeliveryId(
        "gitlab",
        organizationId,
        `${kind}:${data.data.project.id}:${attrs.id}:${attrs.action}:${attrs.updated_at}`
      );
    }
  } catch {
    // ignore parse errors; fall through to random id
  }
  return scopedDeliveryId("gitlab", organizationId, crypto.randomUUID());
}

export async function processGitlabWebhook(c: Context<AppContext>) {
  const providedToken = c.req.header("X-Gitlab-Token") ?? "";
  const rawBody = await c.req.text();

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const payload = gitlabWebhookPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid GitLab payload",
      hint: payload.error.message,
    });
  }

  const data = payload.data;
  const projectPath = data.project.path_with_namespace;
  const db = createD1(c.env.D1);

  const installation = await resolveGitlabInstallation(
    db,
    c.env.GITLAB_WEBHOOK_SECRET,
    projectPath,
    providedToken
  );

  const organizationId = installation?.organizationId;
  if (!organizationId) {
    return c.json({ ok: true }, 200);
  }

  const deliveryId = extractGitlabDeliveryId(
    c.req.raw.headers,
    rawBody,
    organizationId
  );

  await enqueueWebhook(
    db,
    c.env,
    {
      deliveryId,
      source: "gitlab",
      event: data.object_kind,
      organizationId,
      payload: { rawBody, organizationId },
    },
    new Map([["gitlab", processGitlabWebhookPayload]])
  );

  return c.json({ ok: true }, 200);
}

export async function processGitlabWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<void> {
  const parsed = gitlabQueuePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid GitLab queue payload",
      hint: parsed.error.message,
    });
  }

  const { rawBody, organizationId } = parsed.data;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const data = gitlabWebhookPayloadSchema.safeParse(parsedBody);
  if (!data.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid GitLab payload",
      hint: data.error.message,
    });
  }

  const projectPath = data.data.project.path_with_namespace;
  const projectId = data.data.project.id;

  if (data.data.object_kind === "issue") {
    return processGitlabIssue(
      db,
      env,
      organizationId,
      projectPath,
      projectId,
      data.data
    );
  }

  if (data.data.object_kind === "merge_request") {
    return processGitlabMergeRequest(
      db,
      env,
      organizationId,
      projectPath,
      projectId,
      data.data
    );
  }

  if (data.data.object_kind === "note") {
    if (
      data.data.object_attributes.noteable_type === "MergeRequest" &&
      data.data.merge_request
    ) {
      return processGitlabMergeRequestNote(
        db,
        env,
        organizationId,
        projectPath,
        projectId,
        data.data
      );
    }
    if (data.data.issue) {
      return processGitlabIssueNote(
        db,
        env,
        organizationId,
        projectPath,
        projectId,
        data.data
      );
    }
  }
}

async function processGitlabIssue(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabIssuePayloadSchema>
) {
  const attrs = payload.object_attributes;
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const mapping = await findRepoIssue(db, projectPath, attrs.iid, "gitlab");

  const assigneeUsername = attrs.assignees.at(0)?.username;
  const assigneeId = assigneeUsername
    ? ((await findUserByGitlabUsername(db, organizationId, assigneeUsername))
        ?.userId ?? undefined)
    : null;

  const labelNames = attrs.labels
    .map((label) => label.title ?? label.name)
    .filter((name): name is string => Boolean(name));
  const matchedLabels = await findLabelsByWorkspaceAndNames(
    db,
    organizationId,
    labelNames
  );
  const labelIds =
    matchedLabels.length > 0
      ? matchedLabels.map((label) => label.id).join(",")
      : null;

  const cycleId = attrs.milestone
    ? await findOrCreateCycleByName(db, organizationId, attrs.milestone.title)
    : null;

  const status = gitlabStatusFromState(attrs.state, attrs.action);
  const commonPatch = {
    title: attrs.title,
    description: attrs.description ?? undefined,
    assigneeId,
    labelIds,
    cycleId,
    repo: projectPath,
    ...(status !== undefined ? { status } : {}),
  };

  if (attrs.action === "open" || attrs.action === "reopen") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, commonPatch, "gitlab");
    } else {
      const created = await stub.createIssue(
        {
          id: `repo:gitlab:${projectPath.replace(/\//g, ":")}:${attrs.iid}`,
          title: attrs.title,
          description: attrs.description ?? undefined,
          status: status ?? "backlog",
          assigneeId,
          labelIds,
          cycleId,
          repo: projectPath,
        },
        "gitlab"
      );
      await createRepoIssue(
        db,
        organizationId,
        projectPath,
        attrs.iid,
        created.id,
        "gitlab"
      );
    }
  } else if (attrs.action === "update") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, commonPatch, "gitlab");
    }
  } else if (attrs.action === "close") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, { status: "canceled" }, "gitlab");
    }
  } else if (attrs.action === "destroy") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, { status: "canceled" }, "gitlab");
      await deleteRepoIssue(db, projectPath, attrs.iid, "gitlab");
    }
  }
}

async function processGitlabIssueNote(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabNotePayloadSchema>
) {
  const attrs = payload.object_attributes;
  if (!payload.issue) {
    return;
  }

  const mapping = await findRepoIssue(
    db,
    projectPath,
    payload.issue.iid,
    "gitlab"
  );
  if (!mapping) {
    return;
  }

  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const externalId = String(attrs.id);
  const externalSource = "gitlab";
  const externalAuthor =
    payload.author.username || payload.author.name || "gitlab";

  const existingComment = await stub.findCommentByExternalId(
    externalSource,
    externalId
  );

  if (attrs.action === "created") {
    if (!existingComment) {
      await stub.createComment({
        issueId: mapping.issueId,
        body: attrs.note,
        externalId,
        externalSource,
        externalAuthor,
        createdAt: attrs.created_at,
        updatedAt: attrs.updated_at,
      });
    }
  } else if (attrs.action === "updated") {
    if (existingComment) {
      await stub.updateComment(existingComment.id, {
        body: attrs.note,
        updatedAt: attrs.updated_at,
      });
    } else {
      await stub.createComment({
        issueId: mapping.issueId,
        body: attrs.note,
        externalId,
        externalSource,
        externalAuthor,
        createdAt: attrs.created_at,
        updatedAt: attrs.updated_at,
      });
    }
  } else if (attrs.action === "deleted" && existingComment) {
    await stub.deleteComment(existingComment.id);
  }
}

async function processGitlabMergeRequest(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabMergeRequestPayloadSchema>
) {
  const attrs = payload.object_attributes;
  const repo = attrs.source?.path_with_namespace ?? projectPath;
  const branch = attrs.source_branch;
  const prUrl = attrs.url;
  const prState = gitlabPrStateFromAttributes(attrs);

  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  await stub.updatePrState(repo, branch, prUrl, prState, "gitlab");

  const text = [attrs.title, attrs.description ?? "", branch].join(" ");
  const identifiers = parseIssueIdentifiers(text);
  await Promise.all(
    identifiers.map((identifier) =>
      stub.updatePrByIdentifier(
        identifier,
        prUrl,
        prState,
        repo,
        branch,
        "gitlab"
      )
    )
  );
}

async function processGitlabMergeRequestNote(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabNotePayloadSchema>
) {
  const attrs = payload.object_attributes;
  const mr = payload.merge_request;
  if (!mr) {
    return;
  }

  const repo = mr.source?.path_with_namespace ?? projectPath;
  const branch = mr.source_branch;

  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);

  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) {
    return;
  }

  const externalId = String(attrs.id);
  const externalSource = "gitlab";
  const externalAuthor =
    payload.author.username || payload.author.name || "gitlab";

  const filePath = attrs.position?.new_path ?? attrs.position?.old_path;
  const body = filePath ? `[${filePath}] ${attrs.note}` : attrs.note;

  const existingComment = await stub.findCommentByExternalId(
    externalSource,
    externalId
  );

  if (attrs.action === "created") {
    if (!existingComment) {
      await stub.createComment({
        issueId: issue.id,
        body,
        externalId,
        externalSource,
        externalAuthor,
        createdAt: attrs.created_at,
        updatedAt: attrs.updated_at,
      });
    }
  } else if (attrs.action === "updated") {
    if (existingComment) {
      await stub.updateComment(existingComment.id, {
        body,
        updatedAt: attrs.updated_at,
      });
    } else {
      await stub.createComment({
        issueId: issue.id,
        body,
        externalId,
        externalSource,
        externalAuthor,
        createdAt: attrs.created_at,
        updatedAt: attrs.updated_at,
      });
    }
  } else if (attrs.action === "deleted" && existingComment) {
    await stub.deleteComment(existingComment.id);
  }
}

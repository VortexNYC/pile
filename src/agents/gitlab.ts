import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

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
import {
  findWebhookDelivery,
  recordWebhookDelivery,
} from "../global/webhook-deliveries.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
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

function gitlabDeliveryId(
  eventType: string,
  projectId: string | number,
  objectId: string | number,
  updatedAt: string
): string {
  return `gitlab:${eventType}:${projectId}:${objectId}:${updatedAt}`;
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
  const expected = installation?.webhookSecret ?? envToken;
  if (expected && providedToken !== expected) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid GitLab token",
    });
  }
  return installation;
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
  const projectId = data.project.id;
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

  if (data.object_kind === "issue") {
    return processGitlabIssue(
      c,
      db,
      organizationId,
      projectPath,
      projectId,
      data
    );
  }

  if (data.object_kind === "merge_request") {
    return processGitlabMergeRequest(
      c,
      db,
      organizationId,
      projectPath,
      projectId,
      data
    );
  }

  if (data.object_kind === "note") {
    if (
      data.object_attributes.noteable_type === "MergeRequest" &&
      data.merge_request
    ) {
      return processGitlabMergeRequestNote(
        c,
        db,
        organizationId,
        projectPath,
        projectId,
        data
      );
    }
    if (data.issue) {
      return processGitlabIssueNote(
        c,
        db,
        organizationId,
        projectPath,
        projectId,
        data
      );
    }
  }

  return c.json({ ok: true }, 200);
}

async function processGitlabIssue(
  c: Context<AppContext>,
  db: D1Client,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabIssuePayloadSchema>
) {
  const attrs = payload.object_attributes;
  const deliveryId = gitlabDeliveryId(
    "issue",
    projectId,
    attrs.id,
    attrs.updated_at
  );
  const existing = await findWebhookDelivery(db, deliveryId);
  if (existing) {
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
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

  await recordWebhookDelivery(
    db,
    deliveryId,
    "gitlab",
    "issue",
    organizationId
  );
  return c.json({ ok: true }, 200);
}

async function processGitlabIssueNote(
  c: Context<AppContext>,
  db: D1Client,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabNotePayloadSchema>
) {
  const attrs = payload.object_attributes;
  const deliveryId = gitlabDeliveryId(
    "note",
    projectId,
    attrs.id,
    attrs.updated_at
  );
  const existing = await findWebhookDelivery(db, deliveryId);
  if (existing) {
    return c.json({ ok: true }, 200);
  }

  if (!payload.issue) {
    return c.json({ ok: true }, 200);
  }

  const mapping = await findRepoIssue(
    db,
    projectPath,
    payload.issue.iid,
    "gitlab"
  );
  if (!mapping) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "gitlab",
      "note",
      organizationId
    );
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
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

  await recordWebhookDelivery(db, deliveryId, "gitlab", "note", organizationId);
  return c.json({ ok: true }, 200);
}

async function processGitlabMergeRequest(
  c: Context<AppContext>,
  db: D1Client,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabMergeRequestPayloadSchema>
) {
  const attrs = payload.object_attributes;
  const deliveryId = gitlabDeliveryId(
    "merge_request",
    projectId,
    attrs.id,
    attrs.updated_at
  );
  const existing = await findWebhookDelivery(db, deliveryId);
  if (existing) {
    return c.json({ ok: true }, 200);
  }

  const repo = attrs.source?.path_with_namespace ?? projectPath;
  const branch = attrs.source_branch;
  const prUrl = attrs.url;
  const prState = gitlabPrStateFromAttributes(attrs);

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
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

  await recordWebhookDelivery(
    db,
    deliveryId,
    "gitlab",
    "merge_request",
    organizationId
  );
  return c.json({ ok: true }, 200);
}

async function processGitlabMergeRequestNote(
  c: Context<AppContext>,
  db: D1Client,
  organizationId: string,
  projectPath: string,
  projectId: string | number,
  payload: z.infer<typeof gitlabNotePayloadSchema>
) {
  const attrs = payload.object_attributes;
  const deliveryId = gitlabDeliveryId(
    "mr_note",
    projectId,
    attrs.id,
    attrs.updated_at
  );
  const existing = await findWebhookDelivery(db, deliveryId);
  if (existing) {
    return c.json({ ok: true }, 200);
  }

  const mr = payload.merge_request;
  if (!mr) {
    return c.json({ ok: true }, 200);
  }

  const repo = mr.source?.path_with_namespace ?? projectPath;
  const branch = mr.source_branch;

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(organizationId);

  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "gitlab",
      "mr_note",
      organizationId
    );
    return c.json({ ok: true }, 200);
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

  await recordWebhookDelivery(
    db,
    deliveryId,
    "gitlab",
    "mr_note",
    organizationId
  );
  return c.json({ ok: true }, 200);
}

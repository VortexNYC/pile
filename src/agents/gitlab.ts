import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { createD1, type D1Client } from "../global/db.js";
import { findGitlabInstallationByProjectPath } from "../global/gitlab-installations.js";
import { findUserByGitlabUsername } from "../global/gitlab-users.js";
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
        title: z.string(),
      })
    )
    .default([]),
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
});

const gitlabNoteAuthorSchema = z.object({
  username: z.string(),
  name: z.string().default(""),
});

const gitlabNoteIssueSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
});

const gitlabNotePayloadSchema = z.object({
  object_kind: z.literal("note"),
  event_type: z.string().default("note"),
  project: gitlabProjectSchema,
  object_attributes: gitlabNoteAttributesSchema,
  issue: gitlabNoteIssueSchema.optional(),
  merge_request: z.unknown().optional(),
  author: gitlabNoteAuthorSchema,
});

const gitlabWebhookPayloadSchema = z.union([
  gitlabIssuePayloadSchema,
  gitlabNotePayloadSchema,
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

  if (data.object_kind === "note" && data.issue) {
    return processGitlabNote(
      c,
      db,
      organizationId,
      projectPath,
      projectId,
      data
    );
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
    : undefined;

  const status = gitlabStatusFromState(attrs.state, attrs.action);
  const commonPatch = {
    title: attrs.title,
    description: attrs.description ?? undefined,
    assigneeId,
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

async function processGitlabNote(
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

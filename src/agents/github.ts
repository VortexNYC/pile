import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import {
  createComment,
  deleteComment,
  findCommentByExternalId,
  updateComment,
} from "../global/comments.js";
import { hmacSha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { findOrCreateCycleByName } from "../global/cycles.js";
import { createD1, type D1Client } from "../global/db.js";
import {
  createGithubInstallation,
  deleteGithubInstallation,
  deleteGithubInstallationsByInstallationId,
  findWorkspaceByRepo,
} from "../global/github-installations.js";
import { findLabelsByWorkspaceAndNames } from "../global/labels.js";
import {
  createRepoIssue,
  deleteRepoIssue,
  findRepoIssue,
  findRepoWorkspace,
} from "../global/repo-issues.js";
import {
  findWebhookDelivery,
  recordWebhookDelivery,
} from "../global/webhook-deliveries.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    draft: z.boolean().default(false),
    merged: z.boolean().default(false),
    html_url: z.string(),
    head: z.object({
      ref: z.string(),
      repo: z.object({
        full_name: z.string(),
      }),
    }),
  }),
});

function parseIssueIdentifiers(text: string) {
  const regex = /\b([A-Za-z][A-Za-z0-9_-]*-\d+)\b/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
}

const installationPayloadSchema = z.object({
  action: z.enum([
    "created",
    "deleted",
    "new_permissions_accepted",
    "suspend",
    "unsuspend",
  ]),
  installation: z.object({
    id: z.number().int(),
  }),
  repositories: z
    .array(
      z.object({
        full_name: z.string(),
      })
    )
    .default([]),
});

const installationRepositoriesPayloadSchema = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({
    id: z.number().int(),
  }),
  repositories_added: z
    .array(
      z.object({
        full_name: z.string(),
      })
    )
    .default([]),
  repositories_removed: z
    .array(
      z.object({
        full_name: z.string(),
      })
    )
    .default([]),
});

const issueCommentPayloadSchema = z.object({
  action: z.enum(["created", "edited", "deleted"]),
  issue: z.object({
    number: z.number().int(),
    pull_request: z
      .object({
        url: z.string(),
      })
      .optional(),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string(),
    user: z.object({
      login: z.string(),
    }),
    html_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

const pullRequestReviewCommentPayloadSchema = z.object({
  action: z.enum(["created", "edited", "deleted"]),
  pull_request: z.object({
    number: z.number().int(),
    head: z.object({
      ref: z.string(),
      repo: z.object({
        full_name: z.string(),
      }),
    }),
  }),
  comment: z.object({
    id: z.number().int(),
    body: z.string(),
    user: z.object({
      login: z.string(),
    }),
    html_url: z.string(),
    path: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

const issuePayloadSchema = z.object({
  action: z.enum([
    "opened",
    "edited",
    "closed",
    "reopened",
    "deleted",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "milestoned",
    "demilestoned",
  ]),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    html_url: z.string(),
    labels: z
      .array(
        z.object({
          name: z.string(),
        })
      )
      .default([]),
    assignee: z.object({ login: z.string() }).nullable(),
    milestone: z.object({ title: z.string() }).nullable(),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

export const githubWebhookRoute = createRoute({
  method: "post",
  path: "/github",
  tags: ["github"],
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

function extractWorkspaceIdFromLabels(
  labels: Array<{ name: string }>
): string | undefined {
  const label = labels.find((l) => l.name.startsWith("vortex:"));
  return label?.name.split(":")[1]?.trim();
}

export async function processGithubWebhook(c: Context<AppContext>) {
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const rawBody = await c.req.text();

  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const expected = `sha256=${await hmacSha256Hex(
      c.env.GITHUB_WEBHOOK_SECRET,
      rawBody
    )}`;
    if (!timingSafeEqualHex(signature, expected)) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid GitHub signature",
      });
    }
  }

  const event = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");
  const db = createD1(c.env.D1);

  if (deliveryId) {
    const existing = await findWebhookDelivery(db, deliveryId);
    if (existing) {
      return c.json({ ok: true }, 200);
    }
  }

  if (event === "pull_request") {
    return processPullRequest(c, db, deliveryId, event, rawBody);
  }
  if (event === "issues") {
    return processGitHubIssue(c, db, deliveryId, event, rawBody);
  }
  if (event === "installation") {
    return processInstallation(c, db, deliveryId, event, rawBody);
  }
  if (event === "installation_repositories") {
    return processInstallationRepositories(c, db, deliveryId, event, rawBody);
  }
  if (event === "issue_comment") {
    return processIssueComment(c, db, deliveryId, event, rawBody);
  }
  if (event === "pull_request_review_comment") {
    return processPullRequestReviewComment(c, db, deliveryId, event, rawBody);
  }
  return c.json({ ok: true }, 200);
}

async function processInstallation(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = installationPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid installation payload",
      hint: payload.error.message,
    });
  }

  const { action, installation, repositories } = payload.data;
  const installationId = installation.id.toString();

  if (action === "deleted") {
    await deleteGithubInstallationsByInstallationId(db, installationId);
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, "deleted");
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "created" || action === "new_permissions_accepted") {
    await Promise.all(
      repositories.map(async (repo) => {
        const record = await findRepoWorkspace(db, repo.full_name);
        if (record) {
          await createGithubInstallation(
            db,
            record.workspaceId,
            installationId,
            repo.full_name
          );
        }
      })
    );
    if (deliveryId) {
      await recordWebhookDelivery(
        db,
        deliveryId,
        "github",
        event,
        installationId
      );
    }
    return c.json({ ok: true }, 200);
  }

  if (deliveryId) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "github",
      event,
      installationId
    );
  }
  return c.json({ ok: true }, 200);
}

async function processInstallationRepositories(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = installationRepositoriesPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid installation_repositories payload",
      hint: payload.error.message,
    });
  }

  const { action, installation, repositories_added, repositories_removed } =
    payload.data;
  const installationId = installation.id.toString();

  if (action === "removed") {
    await Promise.all(
      repositories_removed.map((repo) =>
        deleteGithubInstallation(db, repo.full_name)
      )
    );
    if (deliveryId) {
      await recordWebhookDelivery(
        db,
        deliveryId,
        "github",
        event,
        installationId
      );
    }
    return c.json({ ok: true }, 200);
  }

  await Promise.all(
    repositories_added.map(async (repo) => {
      const record = await findRepoWorkspace(db, repo.full_name);
      if (record) {
        await createGithubInstallation(
          db,
          record.workspaceId,
          installationId,
          repo.full_name
        );
      }
    })
  );
  if (deliveryId) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "github",
      event,
      installationId
    );
  }
  return c.json({ ok: true }, 200);
}

async function processIssueComment(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = issueCommentPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid issue_comment payload",
      hint: payload.error.message,
    });
  }

  const { action, issue, comment, repository } = payload.data;
  const repo = repository.full_name;

  if (issue.pull_request) {
    // PR issue comments are handled with PR review comments for mapping.
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event);
    }
    return c.json({ ok: true }, 200);
  }

  const mapping = await findRepoIssue(db, repo, issue.number);
  if (!mapping) {
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event);
    }
    return c.json({ ok: true }, 200);
  }

  const workspaceId = mapping.workspaceId;
  const issueId = mapping.issueId;
  const externalId = comment.id.toString();
  const externalSource = "github";
  const externalAuthor = comment.user.login;

  if (action === "created") {
    await createComment(db, workspaceId, {
      issueId,
      body: comment.body,
      externalId,
      externalSource,
      externalAuthor,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
  }

  if (action === "edited") {
    const existing = await findCommentByExternalId(
      db,
      workspaceId,
      externalSource,
      externalId
    );
    if (existing) {
      await updateComment(db, workspaceId, existing.id, {
        body: comment.body,
        updatedAt: comment.updated_at,
      });
    }
  }

  if (action === "deleted") {
    const existing = await findCommentByExternalId(
      db,
      workspaceId,
      externalSource,
      externalId
    );
    if (existing) {
      await deleteComment(db, workspaceId, existing.id);
    }
  }

  if (deliveryId) {
    await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
  }
  return c.json({ ok: true }, 200);
}

async function processPullRequestReviewComment(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = pullRequestReviewCommentPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid pull_request_review_comment payload",
      hint: payload.error.message,
    });
  }

  const { action, pull_request, comment } = payload.data;
  const repo = pull_request.head.repo.full_name;
  const branch = pull_request.head.ref;

  const workspaceRecord = await findWorkspaceByRepo(db, repo);
  if (!workspaceRecord) {
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event);
    }
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(
    workspaceRecord.workspaceId
  );
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) {
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event);
    }
    return c.json({ ok: true }, 200);
  }

  const workspaceId = workspaceRecord.workspaceId;
  const issueId = issue.id;
  const externalId = comment.id.toString();
  const externalSource = "github";
  const externalAuthor = comment.user.login;

  if (action === "created") {
    await createComment(db, workspaceId, {
      issueId,
      body: `[${comment.path}] ${comment.body}`,
      externalId,
      externalSource,
      externalAuthor,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
  }

  if (action === "edited") {
    const existing = await findCommentByExternalId(
      db,
      workspaceId,
      externalSource,
      externalId
    );
    if (existing) {
      await updateComment(db, workspaceId, existing.id, {
        body: `[${comment.path}] ${comment.body}`,
        updatedAt: comment.updated_at,
      });
    }
  }

  if (action === "deleted") {
    const existing = await findCommentByExternalId(
      db,
      workspaceId,
      externalSource,
      externalId
    );
    if (existing) {
      await deleteComment(db, workspaceId, existing.id);
    }
  }

  if (deliveryId) {
    await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
  }
  return c.json({ ok: true }, 200);
}

async function processPullRequest(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = pullRequestPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid pull_request payload",
      hint: payload.error.message,
    });
  }

  const { pull_request } = payload.data;
  const repo = pull_request.head.repo.full_name;
  const branch = pull_request.head.ref;
  const prUrl = pull_request.html_url;
  const prState = pull_request.draft
    ? "draft"
    : pull_request.merged
      ? "merged"
      : pull_request.state;

  const workspaceRecord = await findWorkspaceByRepo(db, repo);
  if (!workspaceRecord) {
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(
    workspaceRecord.workspaceId
  );
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.updatePrState(repo, branch, prUrl, prState, "github");

  const text = [pull_request.title, pull_request.body ?? "", branch].join(" ");
  const identifiers = parseIssueIdentifiers(text);
  await Promise.all(
    identifiers.map((identifier) =>
      stub.updatePrByIdentifier(
        identifier,
        prUrl,
        prState,
        repo,
        branch,
        "github"
      )
    )
  );

  if (deliveryId) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "github",
      event,
      workspaceRecord.workspaceId
    );
  }

  return c.json({ ok: true }, 200);
}

async function processGitHubIssue(
  c: Context<AppContext>,
  db: D1Client,
  deliveryId: string | undefined,
  event: string,
  rawBody: string
) {
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

  const payload = issuePayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid issues payload",
      hint: payload.error.message,
    });
  }

  const { action, issue, repository } = payload.data;
  const repo = repository.full_name;

  let workspaceId = extractWorkspaceIdFromLabels(issue.labels);
  if (!workspaceId) {
    const record = await findWorkspaceByRepo(db, repo);
    workspaceId = record?.workspaceId;
  }

  if (!workspaceId) {
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  const mapping = await findRepoIssue(db, repo, issue.number);

  if (action === "opened" || action === "reopened") {
    const status = action === "reopened" ? "todo" : "backlog";
    const cycleId = issue.milestone
      ? await findOrCreateCycleByName(db, workspaceId, issue.milestone.title)
      : undefined;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
          status,
          cycleId,
          repo,
        },
        "github"
      );
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
    } else {
      const created = await stub.createIssue(
        {
          title: issue.title,
          description: issue.body ?? undefined,
          cycleId,
          repo,
        },
        "github"
      );
      await createRepoIssue(db, workspaceId, repo, issue.number, created.id);
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "edited") {
    const cycleId = issue.milestone
      ? await findOrCreateCycleByName(db, workspaceId, issue.milestone.title)
      : undefined;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
          cycleId,
          repo,
        },
        "github"
      );
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "closed") {
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        { status: "done" },
        "github"
      );
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "deleted") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, { status: "canceled" }, "github");
      await deleteRepoIssue(db, repo, issue.number);
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "labeled" || action === "unlabeled") {
    if (mapping) {
      const names = issue.labels.map((label) => label.name);
      const matched = await findLabelsByWorkspaceAndNames(
        db,
        workspaceId,
        names
      );
      const labelIds =
        matched.length > 0 ? matched.map((label) => label.id).join(",") : null;
      const updated = await stub.updateIssue(
        mapping.issueId,
        { labelIds },
        "github"
      );
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (action === "milestoned" || action === "demilestoned") {
    const cycleId =
      action === "milestoned" && issue.milestone
        ? await findOrCreateCycleByName(db, workspaceId, issue.milestone.title)
        : null;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        { cycleId },
        "github"
      );
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
    }
    if (deliveryId) {
      await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
    }
    return c.json({ ok: true }, 200);
  }

  if (deliveryId) {
    await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
  }
  return c.json({ ok: true }, 200);
}

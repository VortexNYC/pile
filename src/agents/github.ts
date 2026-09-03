import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { hmacSha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1, type D1Client } from "../global/db.js";
import {
  createGithubInstallation,
  deleteGithubInstallation,
  deleteGithubInstallationsByInstallationId,
} from "../global/github-installations.js";
import { findRepoBranch } from "../global/repo-branches.js";
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
    for (const repo of repositories) {
      const record = await findRepoWorkspace(db, repo.full_name);
      if (record) {
        await createGithubInstallation(
          db,
          record.workspaceId,
          installationId,
          repo.full_name
        );
      }
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
    for (const repo of repositories_removed) {
      await deleteGithubInstallation(db, repo.full_name);
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

  for (const repo of repositories_added) {
    const record = await findRepoWorkspace(db, repo.full_name);
    if (record) {
      await createGithubInstallation(
        db,
        record.workspaceId,
        installationId,
        repo.full_name
      );
    }
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

  const record = await findRepoBranch(db, repo, branch);
  if (!record) {
    return c.json({ ok: true }, 200);
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(record.workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.updatePrState(repo, branch, prUrl, prState, "github");

  if (deliveryId) {
    await recordWebhookDelivery(
      db,
      deliveryId,
      "github",
      event,
      record.workspaceId
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
    const record = await findRepoWorkspace(db, repo);
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
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
          status,
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
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
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

  if (deliveryId) {
    await recordWebhookDelivery(db, deliveryId, "github", event, workspaceId);
  }
  return c.json({ ok: true }, 200);
}

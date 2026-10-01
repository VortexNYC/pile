import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualHex,
} from "../global/crypto.js";
import { findOrCreateCycleByName } from "../global/cycles.js";
import { createD1, type D1Client } from "../global/db.js";
import {
  createGithubInstallation,
  deleteGithubInstallation,
  deleteGithubInstallationsByInstallationId,
  findGithubInstallation,
  findWorkspaceByRepo,
} from "../global/github-installations.js";
import { findUserByGithubLogin } from "../global/github-users.js";
import { findLabelsByWorkspaceAndNames } from "../global/labels.js";
import { fetchPileRepoConfig } from "../global/pile-repo-config.js";
import { createRepoBranch } from "../global/repo-branches.js";
import {
  createRepoIssue,
  deleteRepoIssue,
  findRepoIssue,
  findRepoWorkspace,
} from "../global/repo-issues.js";
import { scopedDeliveryId } from "../global/webhook-queue.js";
import { enqueueWebhook } from "../global/webhook-queue.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { dispatchAgent } from "./index.js";
import {
  buildMentionPrompt,
  isTrustedAssociation,
  parsePileMention,
} from "./mention.js";
import { nudgeLane } from "./nudge.js";

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

const checkRunInnerSchema = z.object({
  name: z.string().nullish(),
  head_branch: z.string().nullish(),
  head_sha: z.string(),
  details_url: z.string().nullable().optional(),
  status: z.enum(["queued", "in_progress", "completed", "pending", "waiting"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
    ])
    .nullable()
    .default(null),
});

const checkRunPayloadSchema = z.object({
  action: z.string().optional(),
  check_run: checkRunInnerSchema.optional(),
  check_suite: checkRunInnerSchema.optional(),
  repository: z.object({
    full_name: z.string(),
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
    title: z.string().optional(),
    html_url: z.string().optional(),
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
      type: z.string().optional(),
    }),
    author_association: z.string().optional(),
    html_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

type IssueCommentPayload = z.infer<typeof issueCommentPayloadSchema>;

const pullRequestReviewPayloadSchema = z.object({
  action: z.enum(["submitted", "edited", "dismissed"]),
  review: z.object({
    id: z.number().int(),
    state: z.string(),
    body: z.string().nullable(),
    user: z.object({ login: z.string() }).nullable(),
    html_url: z.string(),
  }),
  pull_request: z.object({
    number: z.number().int(),
    html_url: z.string(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
  }),
});

const pullRequestReviewCommentPayloadSchema = z.object({
  action: z.enum(["created", "edited", "deleted"]),
  pull_request: z.object({
    number: z.number().int(),
    html_url: z.string(),
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

const githubQueuePayloadSchema = z.object({
  event: z.string(),
  rawBody: z.string(),
  deliveryId: z.string().optional(),
});

export async function processGithubWebhook(c: Context<AppContext>) {
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const rawBody = await c.req.text();

  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "GitHub webhook secret not configured",
    });
  }
  const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
  if (!timingSafeEqualHex(signature, expected)) {
    throw new VortexError({
      code: "UNAUTHORIZED",
      status: 401,
      message: "Invalid GitHub signature",
    });
  }

  const event = c.req.header("x-github-event") ?? "unknown";
  const deliveryHeader = c.req.header("x-github-delivery");
  const deliveryId = scopedDeliveryId(
    "github",
    null,
    deliveryHeader ?? (await sha256Hex(rawBody))
  );
  const db = createD1(c.env.D1);

  await enqueueWebhook(
    db,
    c.env,
    {
      deliveryId,
      source: "github",
      event,
      payload: { event, rawBody, deliveryId },
    },
    new Map([["github", processGithubWebhookPayload]])
  );

  return c.json({ ok: true }, 200);
}

export async function processGithubWebhookPayload(
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
): Promise<void> {
  const parsed = githubQueuePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid GitHub queue payload",
      hint: parsed.error.message,
    });
  }

  const { event, rawBody, deliveryId } = parsed.data;

  if (event === "pull_request") {
    return processPullRequest(env, db, deliveryId, event, rawBody);
  }
  if (event === "issues") {
    return processGitHubIssue(env, db, deliveryId, event, rawBody);
  }
  if (event === "installation") {
    return processInstallation(env, db, deliveryId, event, rawBody);
  }
  if (event === "installation_repositories") {
    return processInstallationRepositories(env, db, deliveryId, event, rawBody);
  }
  if (event === "issue_comment") {
    return processIssueComment(env, db, deliveryId, event, rawBody);
  }
  if (event === "pull_request_review_comment") {
    return processPullRequestReviewComment(env, db, deliveryId, event, rawBody);
  }
  if (event === "pull_request_review") {
    return processPullRequestReview(env, db, deliveryId, event, rawBody);
  }
  if (event === "check_run" || event === "check_suite") {
    return processCheckRun(env, db, deliveryId, event, rawBody);
  }
}

async function processInstallation(
  env: WorkerEnv,
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
    return;
  }

  if (action === "created" || action === "new_permissions_accepted") {
    await Promise.all(
      repositories.map(async (repo) => {
        const record = await findRepoWorkspace(db, repo.full_name);
        if (record) {
          await createGithubInstallation(
            db,
            record.organizationId,
            installationId,
            repo.full_name
          );
        }
      })
    );
    return;
  }

  return;
}

async function processInstallationRepositories(
  env: WorkerEnv,
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
    return;
  }

  await Promise.all(
    repositories_added.map(async (repo) => {
      const record = await findRepoWorkspace(db, repo.full_name);
      if (record) {
        await createGithubInstallation(
          db,
          record.organizationId,
          installationId,
          repo.full_name
        );
      }
    })
  );
  return;
}

async function processIssueComment(
  env: WorkerEnv,
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
    // PR conversation comments aren't mirrored — only an @pile mention on a
    // lane's PR is acted on (and mirrored so the ask is visible in Pile).
    if (action === "created") {
      await routePrMention(env, db, payload.data);
    }
    return;
  }

  const mapping = await findRepoIssue(db, repo, issue.number);
  if (!mapping) {
    return;
  }

  const organizationId = mapping.organizationId;
  const issueId = mapping.issueId;
  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(organizationId);
  const externalId = comment.id.toString();
  const externalSource = "github";
  const externalAuthor = comment.user.login;

  if (action === "created") {
    await stub.createComment({
      issueId,
      body: comment.body,
      externalId,
      externalSource,
      externalAuthor,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
    const pileIssue = await stub.getIssue(issueId);
    if (pileIssue) {
      await routePileMention(env, db, stub, organizationId, pileIssue, {
        targetUrl: issue.html_url ?? comment.html_url,
        isPullRequest: false,
        comment,
      });
    }
  }

  if (action === "edited") {
    const existing = await stub.findCommentByExternalId(
      externalSource,
      externalId
    );
    if (existing) {
      await stub.updateComment(existing.id, {
        body: comment.body,
        updatedAt: comment.updated_at,
      });
    }
  }

  if (action === "deleted") {
    const existing = await stub.findCommentByExternalId(
      externalSource,
      externalId
    );
    if (existing) {
      await stub.deleteComment(existing.id);
    }
  }

  return;
}

type WorkspaceStub = ReturnType<WorkerEnv["WORKSPACE_DURABLE_OBJECT"]["get"]>;

async function routePrMention(
  env: WorkerEnv,
  db: D1Client,
  data: IssueCommentPayload
): Promise<void> {
  const { issue, comment, repository } = data;
  if (!parsePileMention(comment.body)) return;
  const workspaceRecord = await findWorkspaceByRepo(db, repository.full_name);
  if (!workspaceRecord) return;
  const organizationId = workspaceRecord.organizationId;
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);

  // issue_comment carries no head ref — resolve the lane's issue by the PR
  // URL it recorded, falling back to an identifier in the PR title.
  const prUrl = issue.html_url ?? comment.html_url.replace(/#.*$/, "");
  let pileIssue = await stub.getIssueByPrUrl(prUrl);
  if (!pileIssue && issue.title) {
    const candidates = await Promise.all(
      parseIssueIdentifiers(issue.title).map((identifier) =>
        stub.getIssueByIdentifier(identifier)
      )
    );
    pileIssue = candidates.find((candidate) => candidate !== undefined);
  }
  if (!pileIssue) return;

  const externalId = comment.id.toString();
  const existing = await stub.findCommentByExternalId("github", externalId);
  if (!existing) {
    await stub.createComment({
      issueId: pileIssue.id,
      body: comment.body,
      externalId,
      externalSource: "github",
      externalAuthor: comment.user.login,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
  }

  await routePileMention(env, db, stub, organizationId, pileIssue, {
    targetUrl: prUrl,
    isPullRequest: true,
    comment,
  });
}

// PILE-278 — `@pile <request>` on a GitHub issue/PR: resume the issue's
// lane with the request + thread as a follow-up, or cold-dispatch one when
// there's no resumable lane. Never throws — a dispatch failure must not
// fail (and re-deliver) the comment sync.
async function routePileMention(
  env: WorkerEnv,
  db: D1Client,
  stub: WorkspaceStub,
  organizationId: string,
  issue: Issue,
  ctx: {
    targetUrl: string;
    isPullRequest: boolean;
    comment: IssueCommentPayload["comment"];
  }
): Promise<void> {
  const { comment } = ctx;
  const mention = parsePileMention(comment.body);
  if (!mention) return;
  // Lanes comment through the GitHub App; a bot echoing "@pile" must not
  // loop back into a dispatch.
  if (comment.user.type === "Bot") return;

  const author = comment.user.login;
  const linked = await findUserByGithubLogin(db, organizationId, author);
  if (!linked && !isTrustedAssociation(comment.author_association)) {
    console.warn("@pile mention ignored: untrusted commenter", {
      issueId: issue.id,
      author,
      association: comment.author_association ?? null,
    });
    return;
  }

  try {
    const thread = (await stub.listComments(issue.id))
      .filter((c) => c.externalId !== comment.id.toString())
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({
        author: c.externalAuthor ?? c.authorId ?? "unknown",
        body: c.body,
      }));
    const prompt = buildMentionPrompt({
      author,
      commentUrl: comment.html_url,
      targetUrl: ctx.targetUrl,
      isPullRequest: ctx.isPullRequest,
      request: mention.request,
      thread,
    });
    const dedupeKey = `mention-${comment.id}`;
    const reason = "@pile mention";
    const prUrl = ctx.isPullRequest
      ? ctx.targetUrl
      : (issue.prUrl ?? ctx.targetUrl);

    const session = await resolveLaneForIssue(stub, issue.id);
    if (
      session &&
      (session.status === "running" ||
        session.status === "waiting" ||
        session.status === "completed")
    ) {
      await nudgeLane(env, stub, organizationId, session, issue, prUrl, {
        prompt,
        reason,
        dedupeKey,
      });
      return;
    }

    const installation = issue.repo
      ? await findGithubInstallation(db, issue.repo)
      : undefined;
    const repoDefault =
      installation?.organizationId === organizationId
        ? installation.defaultAgentId
        : undefined;
    const agentId = repoDefault ?? session?.agentId ?? "devin";
    const pileConfig = issue.repo
      ? await fetchPileRepoConfig(env, issue.repo, issue.branch)
      : null;
    if (
      pileConfig?.agents &&
      pileConfig.agents.length > 0 &&
      !pileConfig.agents.includes(agentId)
    ) {
      console.warn("@pile mention dispatch blocked by .pile/config.json", {
        issueId: issue.id,
        agentId,
      });
      return;
    }
    const providerConfig = await loadProviderConfig(env, stub, agentId);
    const dispatched = await dispatchAgent(
      resolveAgentEnv(env, providerConfig ?? undefined),
      agentId,
      organizationId,
      issue,
      linked
        ? { id: linked.userId, organizationId, type: "user", permissions: [] }
        : {
            id: `github:${author}`,
            organizationId,
            type: "agent",
            permissions: [],
          },
      pileConfig?.model,
      undefined,
      { instructions: prompt, envAllowlist: pileConfig?.env }
    );
    if (session) {
      await stub
        .updateAgentSession(dispatched.id, { retryOf: session.id })
        .catch(() => null);
    }
    await stub
      .addAgentSessionEvent({
        sessionId: dispatched.id,
        type: "mention.dispatch",
        message: `Dispatched from ${author}'s @pile mention (${comment.html_url})`,
        payload: {
          issueId: issue.id,
          key: dedupeKey,
          commentUrl: comment.html_url,
        },
      })
      .catch(() => {});
    if (issue.repo && issue.branch && dispatched.status !== "waiting") {
      await createRepoBranch(
        db,
        organizationId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
  } catch (err) {
    console.error("@pile mention routing failed", {
      issueId: issue.id,
      commentId: comment.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Resolve the lane for an issue: a live session first, else the most
// recent completed one — kept-sandbox providers resume completed lanes on
// the follow-up. Returns null when the issue never had a lane.
async function resolveLaneForIssue(
  stub: WorkspaceStub,
  issueId: string
): Promise<
  Awaited<ReturnType<WorkspaceStub["listAgentSessions"]>>[number] | null
> {
  const sessions = await stub
    .listAgentSessions({ issueId, limit: 20 })
    .catch(() => []);
  // PILE-249 — dead lanes still resolve: a review on a failed/canceled
  // lane's PR gets its detection event plus a prompt.followup_skipped
  // record from nudgeLane instead of silence.
  return (
    sessions.find((s) => s.status === "running" || s.status === "waiting") ??
    sessions.find((s) => s.status === "completed") ??
    sessions.find((s) => s.status === "failed" || s.status === "canceled") ??
    null
  );
}

// PILE-224 — a review/CI event on a lane's PR is steering. Delegates to the
// shared nudge path so webhook and sweep deliveries share the same
// dedupeKey, throttle, and audit events.
async function nudgeLaneForIssue(
  env: WorkerEnv,
  stub: WorkspaceStub,
  organizationId: string,
  issue: Issue,
  prUrl: string,
  opts: { prompt: string; reason: string; dedupeKey?: string }
): Promise<void> {
  try {
    const session = await resolveLaneForIssue(stub, issue.id);
    if (!session) return;
    await nudgeLane(env, stub, organizationId, session, issue, prUrl, opts);
  } catch (err) {
    console.error("webhook lane nudge failed", {
      issueId: issue.id,
      reason: opts.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function processPullRequestReview(
  env: WorkerEnv,
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
  const payload = pullRequestReviewPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid pull_request_review payload",
      hint: payload.error.message,
    });
  }

  const { action, pull_request, review } = payload.data;
  if (action !== "submitted") return;

  const repo = pull_request.head.repo.full_name;
  const branch = pull_request.head.ref;
  const workspaceRecord = await findWorkspaceByRepo(db, repo);
  if (!workspaceRecord) return;

  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceRecord.organizationId)
  );
  await stub.setOrganizationId(workspaceRecord.organizationId);
  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) return;

  const author = review.user?.login ?? "unknown";
  const marker = `review-${review.id}`;
  // Mirror the review onto the issue comment thread (deduped by the
  // review id) — comments on already-filed reviews sync via
  // pull_request_review_comment separately.
  if (review.body?.trim()) {
    const existing = await stub.findCommentByExternalId("github", marker);
    if (existing) {
      await stub.updateComment(existing.id, { body: review.body });
    } else {
      await stub.createComment({
        issueId: issue.id,
        body: `[review:${review.state}] ${review.body}`,
        externalId: marker,
        externalSource: "github",
        externalAuthor: author,
      });
    }
  }

  // Emit the same detection event the sweep produces so neither path
  // re-detects a review the other already recorded; the dedupeKey carries
  // delivery semantics (retry until the lane actually has it).
  const session = await resolveLaneForIssue(stub, issue.id);
  const reviewState = (review.state ?? "").toUpperCase();
  if (session) {
    const seen = await stub
      .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
      .catch(() => []);
    const isNew = !seen.some(
      (e) =>
        e.type === "pr.review" &&
        typeof e.payload === "string" &&
        e.payload.includes(marker)
    );
    if (isNew) {
      await stub
        .addAgentSessionEvent({
          sessionId: session.id,
          type: "pr.review",
          message: `${author} reviewed ${pull_request.html_url}: ${reviewState.toLowerCase()}`,
          payload: {
            prUrl: pull_request.html_url,
            headSha: pull_request.head.sha,
            reviewId: marker,
            state: reviewState,
            reviewer: author,
          },
        })
        .catch(() => {});
    }
  }

  const body = review.body?.trim() ?? "";
  if (reviewState !== "CHANGES_REQUESTED" && body.length === 0) return;
  const reviewPrompt =
    `${author} reviewed ${pull_request.html_url} (${reviewState.toLowerCase()}).\n` +
    (body ? `Review:\n${body}\n` : "") +
    "Read the review comments on the PR, address the feedback, and push.";
  await nudgeLaneForIssue(
    env,
    stub,
    workspaceRecord.organizationId,
    issue,
    pull_request.html_url,
    { prompt: reviewPrompt, reason: "review feedback", dedupeKey: marker }
  );
}

async function processPullRequestReviewComment(
  env: WorkerEnv,
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
    return;
  }

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(
    workspaceRecord.organizationId
  );
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.setOrganizationId(workspaceRecord.organizationId);
  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) {
    return;
  }

  const issueId = issue.id;
  const externalId = comment.id.toString();
  const externalSource = "github";
  const externalAuthor = comment.user.login;

  if (action === "created") {
    await stub.createComment({
      issueId,
      body: `[${comment.path}] ${comment.body}`,
      externalId,
      externalSource,
      externalAuthor,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    });
    await nudgeLaneForIssue(
      env,
      stub,
      workspaceRecord.organizationId,
      issue,
      pull_request.html_url,
      {
        prompt: `${externalAuthor} commented on ${pull_request.html_url} (${comment.path}):\n\n${comment.body}`,
        reason: "review comment",
        dedupeKey: `comment-${comment.id}`,
      }
    );
  }

  if (action === "edited") {
    const existing = await stub.findCommentByExternalId(
      externalSource,
      externalId
    );
    if (existing) {
      await stub.updateComment(existing.id, {
        body: `[${comment.path}] ${comment.body}`,
        updatedAt: comment.updated_at,
      });
    }
  }

  if (action === "deleted") {
    const existing = await stub.findCommentByExternalId(
      externalSource,
      externalId
    );
    if (existing) {
      await stub.deleteComment(existing.id);
    }
  }

  return;
}

async function processPullRequest(
  env: WorkerEnv,
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
    return;
  }

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(
    workspaceRecord.organizationId
  );
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
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

  return;
}

async function processGitHubIssue(
  env: WorkerEnv,
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

  let organizationId = extractWorkspaceIdFromLabels(issue.labels);
  if (!organizationId) {
    const record = await findWorkspaceByRepo(db, repo);
    organizationId = record?.organizationId;
  }

  if (!organizationId) {
    return;
  }

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  const mapping = await findRepoIssue(db, repo, issue.number);

  if (action === "opened" || action === "reopened") {
    const status = action === "reopened" ? "todo" : "backlog";
    const cycleId = issue.milestone
      ? await findOrCreateCycleByName(db, organizationId, issue.milestone.title)
      : undefined;
    const assigneeId = issue.assignee
      ? ((await findUserByGithubLogin(db, organizationId, issue.assignee.login))
          ?.userId ?? undefined)
      : undefined;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
          status,
          cycleId,
          assigneeId,
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
          id: `repo:github:${repo.replace(/\//g, ":")}:${issue.number}`,
          title: issue.title,
          description: issue.body ?? undefined,
          cycleId,
          assigneeId,
          repo,
        },
        "github"
      );
      await createRepoIssue(db, organizationId, repo, issue.number, created.id);
    }
    return;
  }

  if (action === "edited") {
    const cycleId = issue.milestone
      ? await findOrCreateCycleByName(db, organizationId, issue.milestone.title)
      : undefined;
    const assigneeId = issue.assignee
      ? ((await findUserByGithubLogin(db, organizationId, issue.assignee.login))
          ?.userId ?? undefined)
      : undefined;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        {
          title: issue.title,
          description: issue.body ?? undefined,
          cycleId,
          assigneeId,
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
    return;
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
    return;
  }

  if (action === "deleted") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, { status: "canceled" }, "github");
      await deleteRepoIssue(db, repo, issue.number);
    }
    return;
  }

  if (action === "labeled" || action === "unlabeled") {
    if (mapping) {
      const names = issue.labels.map((label) => label.name);
      const matched = await findLabelsByWorkspaceAndNames(
        db,
        organizationId,
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
    return;
  }

  if (action === "assigned" || action === "unassigned") {
    const assigneeId =
      action === "assigned" && issue.assignee
        ? ((
            await findUserByGithubLogin(
              db,
              organizationId,
              issue.assignee.login
            )
          )?.userId ?? undefined)
        : null;
    if (mapping) {
      const updated = await stub.updateIssue(
        mapping.issueId,
        { assigneeId },
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
    return;
  }

  if (action === "milestoned" || action === "demilestoned") {
    const cycleId =
      action === "milestoned" && issue.milestone
        ? await findOrCreateCycleByName(
            db,
            organizationId,
            issue.milestone.title
          )
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
    return;
  }

  return;
}

async function processCheckRun(
  env: WorkerEnv,
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

  const payload = checkRunPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid check_run payload",
      hint: payload.error.message,
    });
  }

  const check_run = payload.data.check_run ?? payload.data.check_suite;
  if (!check_run) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid check_run payload",
    });
  }
  const { repository } = payload.data;
  const repo = repository.full_name;
  const branch = check_run.head_branch;
  if (!branch) {
    return;
  }
  const prCheckState =
    check_run.status === "completed"
      ? (check_run.conclusion ?? "completed")
      : check_run.status;

  const workspaceRecord = await findWorkspaceByRepo(db, repo);
  if (!workspaceRecord) {
    return;
  }

  const doId = env.WORKSPACE_DURABLE_OBJECT.idFromName(
    workspaceRecord.organizationId
  );
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.updatePrCheckState(repo, branch, prCheckState, "github");

  // Fast path for CI failures — same detection event + delivery dedupeKey
  // the sweep uses, so whichever path sees the red check first delivers it
  // and the other skips. The 5-min sweep remains the backstop.
  const failed =
    check_run.status === "completed" &&
    (check_run.conclusion === "failure" ||
      check_run.conclusion === "timed_out" ||
      check_run.conclusion === "action_required");
  if (!failed) return;

  await stub.setOrganizationId(workspaceRecord.organizationId);
  const issue = await stub.getIssueByBranch(repo, branch);
  if (!issue) return;
  const session = await resolveLaneForIssue(stub, issue.id);
  if (!session) return;

  const dedupeKey = `ci-${check_run.head_sha}`;
  const prUrl = issue.prUrl ?? "";
  const seen = await stub
    .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
    .catch(() => []);
  const isNew = !seen.some(
    (e) =>
      e.type === "pr.ci_failed" &&
      typeof e.payload === "string" &&
      e.payload.includes(check_run.head_sha)
  );
  if (isNew) {
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "pr.ci_failed",
        message: `CI failing on ${prUrl || `${repo}@${branch}`}`,
        payload: {
          prUrl,
          headSha: check_run.head_sha,
          checkState: check_run.conclusion,
          failingChecks: [check_run.name ?? "check_suite"],
        },
      })
      .catch(() => {});
  }
  await nudgeLaneForIssue(
    env,
    stub,
    workspaceRecord.organizationId,
    issue,
    prUrl,
    {
      prompt:
        `CI is failing on ${prUrl || `${repo} branch ${branch}`} (sha ${check_run.head_sha}).\n` +
        `Failing check: ${check_run.name ?? "check_suite"}${check_run.details_url ? ` (${check_run.details_url})` : ""}\n` +
        "Fetch the failing check runs, fix, and push.",
      reason: "CI failure",
      dedupeKey,
    }
  );

  return;
}

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualHex,
} from "../global/crypto.js";
import { findOrCreateCycleByName } from "../global/cycles.js";
import { createD1, type D1Client } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
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
import { dispatchAgent, inheritTeamDefaultRepo } from "./index.js";
import {
  buildMentionPrompt,
  isTrustedAssociation,
  parsePileMention,
} from "./mention.js";
import { nudgeLane, type NudgeOptions, resolveLaneForIssue } from "./nudge.js";
import {
  type AutomationEventTarget,
  automationEventTarget,
  issueEventTarget,
} from "./repo-triggers.js";
import { reviewPromptWithContext } from "./review-context.js";
import {
  resolveAddressedReviewThreads,
  reviewAutomationEvents,
} from "./review-loop.js";
import {
  REVIEW_CHECK_NAME,
  REVIEW_PURPOSE,
  requestPrReview,
} from "./review.js";
import { fireEventAutomations, githubApiGet } from "./sweep.js";

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }).optional(),
  label: z.object({ name: z.string() }).optional(),
  pull_request: z.object({
    number: z.number().int().optional(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    draft: z.boolean().default(false),
    merged: z.boolean().default(false),
    html_url: z.string(),
    head: z.object({
      ref: z.string(),
      sha: z.string().optional(),
      repo: z.object({
        full_name: z.string(),
      }),
    }),
    base: z.object({ ref: z.string() }).optional(),
  }),
});

const REVIEW_TRIGGER_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

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
    commit_id: z.string().nullish(),
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
      sha: z.string().optional(),
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
      type: z.string().optional(),
    }),
    author_association: z.string().optional(),
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
  label: z.object({ name: z.string() }).optional(),
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
    // Repo `mention` triggers fire too.
    if (action !== "created") return;
    await routePrMention(env, db, payload.data);
    const record = await findWorkspaceByRepo(db, repo);
    if (!record) return;
    const prStub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(record.organizationId)
    );
    await prStub.setOrganizationId(record.organizationId);
    await fireMention(
      env,
      db,
      prStub,
      record.organizationId,
      prEventTarget(
        prStub,
        repo,
        {
          number: issue.number,
          title: issue.title ?? `${repo}#${issue.number}`,
          htmlUrl: issue.html_url ?? comment.html_url,
        },
        null
      ),
      comment
    );
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
        repo,
        comment,
      });
    }
    await fireMention(
      env,
      db,
      stub,
      organizationId,
      issueEventTarget(stub, issueId),
      comment
    );
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

// PR events land on the issue that owns the PR branch; PRs without one get a
// deterministic per-PR issue, created only once an automation matches.
function prEventTarget(
  stub: WorkspaceStub,
  repo: string,
  pr: { number?: number; title: string; htmlUrl: string; body?: string | null },
  branch: string | null
): AutomationEventTarget {
  return automationEventTarget(async () => {
    const owned = branch
      ? await stub.getIssueByBranch(repo, branch)
      : undefined;
    if (owned) return owned;
    if (pr.number === undefined) return null;
    return stub.createIssue(
      {
        id: `repo:github:${repo.replace(/\//g, ":")}:pr:${pr.number}`,
        title: pr.title,
        description: [pr.htmlUrl, pr.body ?? ""].filter(Boolean).join("\n\n"),
        repo,
        branch,
      },
      "github"
    );
  }, repo);
}

// `mention` fires for human comments carrying an @-handle; per-trigger
// handle matching happens in matchRepoTriggers. Bot comments never fire, so
// a lane quoting a handle can't re-trigger itself.
async function fireMention(
  env: WorkerEnv,
  db: D1Client,
  stub: WorkspaceStub,
  organizationId: string,
  target: AutomationEventTarget,
  comment: {
    body: string;
    html_url: string;
    user: { login: string; type?: string };
    author_association?: string;
  }
): Promise<void> {
  const bot =
    comment.user.type === "Bot" || comment.user.login.endsWith("[bot]");
  if (bot || !/@[\w-]/.test(comment.body)) return;
  if (
    !isTrustedAssociation(comment.author_association) &&
    !(await findUserByGithubLogin(db, organizationId, comment.user.login))
  ) {
    return;
  }
  await fireEventAutomations(
    env,
    stub,
    organizationId,
    "mention",
    target,
    `${comment.user.login} mentioned you on ${comment.html_url}:\n\n${comment.body}`,
    undefined,
    { body: comment.body }
  );
}

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
    repo: repository.full_name,
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
    /** Repo the comment was posted in (`repository.full_name`). */
    repo?: string;
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
    // PILE-321 — the mention happened in ctx.repo, so a repo-less issue
    // adopts it (persisted, like the dispatch-time team-defaultRepo
    // inheritance) and the lane clones the repo the commenter was looking
    // at instead of returning a spec. Team defaultRepo covers the
    // repo-less event case.
    const actorId = linked?.userId ?? `github:${author}`;
    if (!issue.repo && ctx.repo) {
      const persisted = await stub
        .updateIssue(issue.id, { repo: ctx.repo }, actorId)
        .catch((err: unknown) => {
          console.warn("@pile mention could not persist the webhook repo", {
            issueId: issue.id,
            repo: ctx.repo,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
      issue = persisted ?? { ...issue, repo: ctx.repo };
    }
    issue = await inheritTeamDefaultRepo(
      db,
      stub,
      organizationId,
      issue,
      actorId
    );

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

    const session = await resolveLaneForIssue(stub, issue.id, {
      excludePurpose: REVIEW_PURPOSE,
    });
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

// PILE-224 — a review/CI event on a lane's PR is steering. Delegates to the
// shared nudge path so webhook and sweep deliveries share the same
// dedupeKey, throttle, and audit events.
async function nudgeLaneForIssue(
  env: WorkerEnv,
  stub: WorkspaceStub,
  organizationId: string,
  issue: Issue,
  prUrl: string,
  opts: NudgeOptions
): Promise<void> {
  try {
    const session = await resolveLaneForIssue(stub, issue.id, {
      excludePurpose: REVIEW_PURPOSE,
    });
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
  const session = await resolveLaneForIssue(stub, issue.id, {
    excludePurpose: REVIEW_PURPOSE,
  });
  const reviewState = (review.state ?? "").toUpperCase();
  let isNewReview = false;
  if (session) {
    const seen = await stub
      .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
      .catch(() => []);
    isNewReview = !seen.some(
      (e) =>
        e.type === "pr.review" &&
        typeof e.payload === "string" &&
        e.payload.includes(marker)
    );
    if (isNewReview) {
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
  // PILE-286 — every verdict (approvals too) rolls into the lane's
  // snapshot; lastReviewedSha anchors the next review's range diff.
  const reviewSha = review.commit_id ?? pull_request.head.sha;
  const recorded = session
    ? await stub
        .recordLaneReview(session.id, {
          reviewId: review.id,
          reviewer: author,
          state: reviewState,
          sha: reviewSha,
          excerpt: body,
        })
        .catch(() => null)
    : null;
  if (reviewState !== "CHANGES_REQUESTED" && body.length === 0) return;
  const [owner = "", name = ""] = repo.split("/");
  const reviewPrompt = async () => {
    const token = await getInstallationTokenForRepo(env, owner, name).catch(
      () => undefined
    );
    return reviewPromptWithContext({
      reviewer: author,
      prUrl: pull_request.html_url,
      state: reviewState,
      body,
      reviewId: review.id,
      sha: reviewSha,
      reviewSummary: recorded?.reviewSummary ?? session?.reviewSummary ?? null,
      repoFull: repo,
      ghGet: token ? (path) => githubApiGet(fetch, token, path) : null,
    });
  };
  // PILE-274 — the webhook is usually first to see a review, so it owns
  // the once-per-review automation fire; the sweep skips reviews it finds
  // already recorded.
  if (session && isNewReview) {
    const automationPrompt = await reviewPrompt();
    for (const eventName of reviewAutomationEvents(reviewState, body)) {
      await fireEventAutomations(
        env,
        stub,
        workspaceRecord.organizationId,
        eventName,
        issueEventTarget(stub, session.issueId),
        automationPrompt
      );
    }
  }
  await nudgeLaneForIssue(
    env,
    stub,
    workspaceRecord.organizationId,
    issue,
    pull_request.html_url,
    {
      prompt: reviewPrompt,
      reason: "review feedback",
      dedupeKey: marker,
      headSha: pull_request.head.sha,
    }
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
        headSha: pull_request.head.sha ?? null,
      }
    );
    await fireMention(
      env,
      db,
      stub,
      workspaceRecord.organizationId,
      automationEventTarget(async () => issue, repo),
      comment
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

  const { action, label, pull_request } = payload.data;
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

  // PILE-274 fast path: a push to a lane PR may be the fix for review
  // feedback the lane was sent — resolve those threads now instead of on
  // the next sweep tick.
  if (
    action === "synchronize" &&
    prState === "open" &&
    pull_request.head.sha &&
    pull_request.number !== undefined
  ) {
    await resolveThreadsOnPush(env, stub, {
      organizationId: workspaceRecord.organizationId,
      repo,
      branch,
      prUrl,
      number: pull_request.number,
      headSha: pull_request.head.sha,
    });
  }

  // PILE-273 — fast path for the review lane; the sweep is the backstop.
  const headSha = pull_request.head.sha;
  const baseRef = pull_request.base?.ref;
  const baseRepo = payload.data.repository?.full_name ?? repo;
  const pullNumber = pull_request.number;
  if (
    !REVIEW_TRIGGER_ACTIONS.has(payload.data.action) ||
    prState !== "open" ||
    !headSha ||
    !baseRef ||
    pullNumber === undefined
  ) {
    return;
  }
  await stub.setOrganizationId(workspaceRecord.organizationId);
  let issue = await stub.getIssueByBranch(repo, branch);
  for (const identifier of identifiers) {
    if (issue) break;
    issue = await stub.getIssueByIdentifier(identifier);
  }
  if (!issue) return;
  const [owner, name] = baseRepo.split("/");
  const token = await getInstallationTokenForRepo(env, owner, name).catch(
    () => undefined
  );
  if (!token) return;
  await requestPrReview(
    env,
    stub,
    workspaceRecord.organizationId,
    issue,
    {
      repoFull: baseRepo,
      pullNumber,
      prUrl,
      headSha,
      baseRef,
      title: pull_request.title,
      body: pull_request.body,
    },
    token
  );
  const prEvent =
    action === "opened"
      ? "pr.opened"
      : action === "synchronize"
        ? "pr.synchronize"
        : action === "labeled"
          ? "label.added"
          : null;
  if (prEvent) {
    await stub.setOrganizationId(workspaceRecord.organizationId);
    await fireEventAutomations(
      env,
      stub,
      workspaceRecord.organizationId,
      prEvent,
      prEventTarget(
        stub,
        repo,
        {
          number: pull_request.number,
          title: pull_request.title,
          htmlUrl: prUrl,
          body: pull_request.body,
        },
        branch
      ),
      prEvent === "label.added"
        ? `Label "${label?.name ?? ""}" was added to ${prUrl} (branch ${branch}).`
        : `PR ${prUrl} (branch ${branch}): ${pull_request.title}`,
      undefined,
      { label: label?.name }
    );
  }

  return;
}

async function resolveThreadsOnPush(
  env: WorkerEnv,
  stub: WorkspaceStub,
  pr: {
    organizationId: string;
    repo: string;
    branch: string;
    prUrl: string;
    number: number;
    headSha: string;
  }
): Promise<void> {
  try {
    await stub.setOrganizationId(pr.organizationId);
    const issue = await stub.getIssueByBranch(pr.repo, pr.branch);
    if (!issue) return;
    const session = await resolveLaneForIssue(stub, issue.id, {
      excludePurpose: REVIEW_PURPOSE,
    });
    if (!session) return;
    const [owner, name] = pr.repo.split("/");
    if (!owner || !name) return;
    const token = await getInstallationTokenForRepo(env, owner, name);
    if (!token) return;
    await resolveAddressedReviewThreads(
      stub,
      session,
      {
        owner,
        repo: name,
        number: pr.number,
        prUrl: pr.prUrl,
        headSha: pr.headSha,
      },
      { token, fetch }
    );
  } catch (err) {
    console.error("webhook review thread resolve failed", {
      prUrl: pr.prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
      if (action === "opened") {
        await stub.setOrganizationId(organizationId);
        await fireEventAutomations(
          env,
          stub,
          organizationId,
          "issue.created",
          automationEventTarget(async () => created, repo),
          `GitHub issue ${issue.html_url} was opened: ${issue.title}`
        );
      }
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
      if (action === "labeled" && payload.data.label) {
        await stub.setOrganizationId(organizationId);
        await fireEventAutomations(
          env,
          stub,
          organizationId,
          "label.added",
          automationEventTarget(async () => updated, repo),
          `Label "${payload.data.label.name}" was added to ${issue.html_url}.`,
          undefined,
          { label: payload.data.label.name }
        );
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
  // Pile's own review verdict (PILE-273) is not CI state.
  if (!branch || check_run.name === REVIEW_CHECK_NAME) {
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
  const session = await resolveLaneForIssue(stub, issue.id, {
    excludePurpose: REVIEW_PURPOSE,
  });
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
      headSha: check_run.head_sha,
    }
  );

  return;
}

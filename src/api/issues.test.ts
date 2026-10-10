import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

interface CaptureIssue {
  status: string;
  title?: string;
  description?: string;
}

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-issues",
      name: "Issues User",
      email: "issues-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-issues");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Issues test",
    slug: `issues-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-issues",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-issues",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env);
}

describe("issues API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
    registerAgentProvider("mock", () => new MockAgentProvider("mock"));
  });

  it("rejects listing issues without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/issues`);
    expect(res.status).toBe(401);
  });

  it("clamps an oversized issue list limit", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues?limit=500`,
      {},
      token
    );
    expect(res.status).toBe(200);
  });

  it("returns an existing issue for an idempotent externalRef create", async () => {
    const externalRef = `test:${crypto.randomUUID()}`;
    const first = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Idempotent issue", externalRef }),
      },
      token
    );
    expect(first.status).toBe(201);
    const firstIssue = z.object({ id: z.string() }).parse(await first.json());

    const second = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Should not duplicate", externalRef }),
      },
      token
    );
    expect(second.status).toBe(200);
    const secondIssue = z.object({ id: z.string() }).parse(await second.json());
    expect(secondIssue.id).toBe(firstIssue.id);

    const listed = await fetch(
      `/workspaces/${organizationId}/issues?externalRef=${encodeURIComponent(externalRef)}`,
      {},
      token
    );
    expect(listed.status).toBe(200);
    const body = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(await listed.json());
    expect(body.issues.map((issue) => issue.id)).toEqual([firstIssue.id]);

    const other = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Another issue" }),
      },
      token
    );
    const otherIssue = z.object({ id: z.string() }).parse(await other.json());
    const conflict = await fetch(
      `/workspaces/${organizationId}/issues/${otherIssue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ externalRef }),
      },
      token
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects nested parent updates and parenting issues with children", async () => {
    const create = async (title: string, parentId?: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        {
          method: "POST",
          body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
        },
        token
      );
      expect(res.status).toBe(201);
      return z.object({ id: z.string() }).parse(await res.json());
    };
    const parent = await create("Parent");
    const child = await create("Child", parent.id);
    const candidate = await create("Candidate");

    const nested = await fetch(
      `/workspaces/${organizationId}/issues/${candidate.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ parentId: child.id }),
      },
      token
    );
    expect(nested.status).toBe(400);
    expect(await nested.text()).toContain(
      "Sub-issues can only be nested one level"
    );

    const withChildren = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ parentId: candidate.id }),
      },
      token
    );
    expect(withChildren.status).toBe(400);
    expect(await withChildren.text()).toContain(
      "An issue with sub-issues cannot become a sub-issue"
    );
  });

  it("rejects creating an issue without a title", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ description: "No title" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating an issue with an invalid priority", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Bad priority",
          priority: "critical",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating an issue without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "No auth",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({
          title: "Updated",
        }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("accepts KEY-N identifiers on every route that takes an issue id", async () => {
    const issueSchema = z.object({
      id: z.string(),
      identifier: z.string().nullable(),
    });
    const create = async (body: Record<string, unknown>) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        { method: "POST", body: JSON.stringify(body) },
        token
      );
      expect(res.status).toBe(201);
      return issueSchema.parse(await res.json());
    };
    const issue = await create({ title: "Identifier routing" });
    const identifier = issue.identifier;
    expect(identifier).toMatch(/^\S+-\d+$/);
    const ref = identifier!;

    const got = await fetch(
      `/workspaces/${organizationId}/issues/${ref}`,
      {},
      token
    );
    expect(got.status).toBe(200);
    expect(z.object({ id: z.string() }).parse(await got.json()).id).toBe(
      issue.id
    );

    const patched = await fetch(
      `/workspaces/${organizationId}/issues/${ref}`,
      { method: "PATCH", body: JSON.stringify({ title: "Renamed by ref" }) },
      token
    );
    expect(patched.status).toBe(200);
    expect(
      z.object({ title: z.string() }).parse(await patched.json()).title
    ).toBe("Renamed by ref");

    // parentId body field resolves identifiers too
    const child = await create({ title: "Child by ref", parentId: ref });
    const childRes = await fetch(
      `/workspaces/${organizationId}/issues/${child.id}`,
      {},
      token
    );
    expect(
      z.object({ parentId: z.string().nullable() }).parse(await childRes.json())
        .parentId
    ).toBe(issue.id);

    const children = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/children`,
      {},
      token
    );
    expect(children.status).toBe(200);
    const childrenBody = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(await children.json());
    expect(childrenBody.issues.map((c) => c.id)).toEqual([child.id]);

    // ?parentId=<identifier> filters the issue list
    const byParent = await fetch(
      `/workspaces/${organizationId}/issues?parentId=${encodeURIComponent(ref)}`,
      {},
      token
    );
    expect(byParent.status).toBe(200);
    const byParentBody = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(await byParent.json());
    expect(byParentBody.issues.map((c) => c.id)).toEqual([child.id]);

    // comments addressed by identifier attach to the canonical UUID
    const commentRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/comments`,
      { method: "POST", body: JSON.stringify({ body: "via identifier" }) },
      token
    );
    expect(commentRes.status).toBe(201);
    const comment = z
      .object({ id: z.string(), issueId: z.string() })
      .parse(await commentRes.json());
    expect(comment.issueId).toBe(issue.id);

    const commentsRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/comments`,
      {},
      token
    );
    expect(commentsRes.status).toBe(200);
    const comments = z
      .object({ comments: z.array(z.object({ id: z.string() })) })
      .parse(await commentsRes.json());
    expect(comments.comments.map((c) => c.id)).toContain(comment.id);

    const getCommentRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/comments/${comment.id}`,
      {},
      token
    );
    expect(getCommentRes.status).toBe(200);

    const branchName = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/branch-name`,
      {},
      token
    );
    expect(branchName.status).toBe(200);
    expect(
      z.object({ branchName: z.string() }).parse(await branchName.json())
        .branchName
    ).toContain(ref);

    const [historyRes, activityRes, attachmentsRes, liveRes, approvalsRes] =
      await Promise.all([
        fetch(`/workspaces/${organizationId}/issues/${ref}/history`, {}, token),
        fetch(
          `/workspaces/${organizationId}/issues/${ref}/activity`,
          {},
          token
        ),
        fetch(
          `/workspaces/${organizationId}/issues/${ref}/attachments`,
          {},
          token
        ),
        fetch(`/workspaces/${organizationId}/issues/${ref}/live`, {}, token),
        fetch(
          `/workspaces/${organizationId}/issues/${ref}/approvals`,
          {},
          token
        ),
      ]);
    expect(historyRes.status).toBe(200);
    expect(activityRes.status).toBe(200);
    expect(attachmentsRes.status).toBe(200);
    expect(liveRes.status).toBe(200);
    expect(approvalsRes.status).toBe(200);
    const history = z
      .object({ history: z.array(z.object({ issueId: z.string() })) })
      .parse(await historyRes.json());
    expect(history.history.every((row) => row.issueId === issue.id)).toBe(true);

    const other = await create({ title: "Relation target" });
    const relationRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/relations`,
      {
        method: "POST",
        body: JSON.stringify({
          toIssueId: other.identifier,
          type: "related",
        }),
      },
      token
    );
    expect(relationRes.status).toBe(201);
    const relation = z
      .object({ fromIssueId: z.string(), toIssueId: z.string() })
      .parse(await relationRes.json());
    expect(relation.fromIssueId).toBe(issue.id);
    expect(relation.toIssueId).toBe(other.id);

    const linkRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/external-links`,
      {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/spec" }),
      },
      token
    );
    expect(linkRes.status).toBe(201);
    expect(
      z.object({ entityId: z.string() }).parse(await linkRes.json()).entityId
    ).toBe(issue.id);

    const reactionRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji: "👍" }) },
      token
    );
    expect(reactionRes.status).toBe(201);
    expect(
      z.object({ targetId: z.string() }).parse(await reactionRes.json())
        .targetId
    ).toBe(issue.id);

    const subscriberRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/subscribers`,
      {
        method: "POST",
        body: JSON.stringify({ linearUserId: "user-issues" }),
      },
      token
    );
    expect(subscriberRes.status).toBe(201);
    expect(
      z.object({ issueId: z.string() }).parse(await subscriberRes.json())
        .issueId
    ).toBe(issue.id);

    const batchRes = await fetch(
      `/workspaces/${organizationId}/issues/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: [ref, other.identifier],
          patch: { status: "todo" },
        }),
      },
      token
    );
    expect(batchRes.status).toBe(200);
    const batchBody = z
      .object({
        issues: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(await batchRes.json());
    expect(batchBody.issues.map((row) => row.id).toSorted()).toEqual(
      [issue.id, other.id].toSorted()
    );
    expect(batchBody.issues.every((row) => row.status === "todo")).toBe(true);

    const dispatchRes = await fetch(
      `/workspaces/${organizationId}/issues/${ref}/dispatch`,
      { method: "POST", body: JSON.stringify({ agentId: "mock" }) },
      token
    );
    expect(dispatchRes.status).toBe(201);
    const session = z
      .object({ issueId: z.string() })
      .parse(await dispatchRes.json());
    expect(session.issueId).toBe(issue.id);

    const sessionsRes = await fetch(
      `/workspaces/${organizationId}/agent/sessions?issueId=${encodeURIComponent(ref)}`,
      {},
      token
    );
    expect(sessionsRes.status).toBe(200);
    const sessions = z
      .object({ sessions: z.array(z.object({ issueId: z.string() })) })
      .parse(await sessionsRes.json());
    expect(sessions.sessions.map((row) => row.issueId)).toEqual([issue.id]);

    const deleted = await fetch(
      `/workspaces/${organizationId}/issues/${ref}`,
      { method: "DELETE" },
      token
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await fetch(
      `/workspaces/${organizationId}/issues/${ref}`,
      {},
      token
    );
    expect(afterDelete.status).toBe(404);
  });

  it("clears nullable fields when PATCHed with null", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Clearable fields",
          description: "has a description",
          repo: "VortexNYC/pile",
          branch: "issue-255",
          estimate: 3,
          assigneeId: "user-issues",
          projectId: "project-1",
          labelIds: ["label-a"],
        }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z
      .object({
        id: z.string(),
        repo: z.string().nullable(),
        branch: z.string().nullable(),
      })
      .parse(await createRes.json());
    expect(issue.repo).toBe("VortexNYC/pile");
    expect(issue.branch).toBe("issue-255");

    const patchRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          description: null,
          repo: null,
          branch: null,
          estimate: null,
          assigneeId: null,
          projectId: null,
          cycleId: null,
          labelIds: null,
          parentId: null,
          snoozedUntil: null,
          resolution: null,
          externalRef: null,
        }),
      },
      token
    );
    expect(patchRes.status).toBe(200);
    const patched = z
      .object({
        description: z.string().nullable(),
        repo: z.string().nullable(),
        branch: z.string().nullable(),
        estimate: z.number().nullable(),
        assigneeId: z.string().nullable(),
        projectId: z.string().nullable(),
        cycleId: z.string().nullable(),
        labelIds: z.string().nullable(),
        parentId: z.string().nullable(),
        snoozedUntil: z.string().nullable(),
      })
      .parse(await patchRes.json());
    expect(patched).toEqual({
      description: null,
      repo: null,
      branch: null,
      estimate: null,
      assigneeId: null,
      projectId: null,
      cycleId: null,
      labelIds: null,
      parentId: null,
      snoozedUntil: null,
    });

    // labelIds can also be cleared with an empty list
    const relabeled = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ labelIds: ["label-b"] }),
      },
      token
    );
    expect(relabeled.status).toBe(200);
    const clearedLabels = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      { method: "PATCH", body: JSON.stringify({ labelIds: [] }) },
      token
    );
    expect(clearedLabels.status).toBe(200);
    expect(
      z
        .object({ labelIds: z.string().nullable() })
        .parse(await clearedLabels.json()).labelIds
    ).toBeNull();

    // non-nullable fields still reject null
    const badTitle = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      { method: "PATCH", body: JSON.stringify({ title: null }) },
      token
    );
    expect(badTitle.status).toBe(400);
    const badStatus = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      { method: "PATCH", body: JSON.stringify({ status: null }) },
      token
    );
    expect(badStatus.status).toBe(400);
  });

  it("sets repo and branch via PATCH", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Link a working branch",
          repo: "VortexNYC/pile",
          branch: "issue-placeholder",
        }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await createRes.json());

    const branchPatch = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ branch: "vor-631-dispute-money-leg" }),
      },
      token
    );
    expect(branchPatch.status).toBe(200);
    const branched = z
      .object({
        repo: z.string().nullable(),
        branch: z.string().nullable(),
      })
      .parse(await branchPatch.json());
    expect(branched).toEqual({
      repo: "VortexNYC/pile",
      branch: "vor-631-dispute-money-leg",
    });

    const repoPatch = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          repo: "VortexNYC/vortex",
          branch: "vor-631-second",
        }),
      },
      token
    );
    expect(repoPatch.status).toBe(200);
    const repoPatched = z
      .object({
        repo: z.string().nullable(),
        branch: z.string().nullable(),
      })
      .parse(await repoPatch.json());
    expect(repoPatched).toEqual({
      repo: "VortexNYC/vortex",
      branch: "vor-631-second",
    });
  });

  it("returns 409 when a PATCHed repo+branch is claimed by another issue", async () => {
    const create = async (title: string, branch: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        {
          method: "POST",
          body: JSON.stringify({
            title,
            repo: "VortexNYC/pile",
            branch,
          }),
        },
        token
      );
      expect(res.status).toBe(201);
      return z.object({ id: z.string() }).parse(await res.json());
    };
    await create("Claims the branch", "shared-branch");
    const other = await create("Wants the branch", "other-branch");

    const conflict = await fetch(
      `/workspaces/${organizationId}/issues/${other.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ branch: "shared-branch" }),
      },
      token
    );
    expect(conflict.status).toBe(409);
  });

  it("sets and clears prUrl and prState via PATCH", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Link a pull request" }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z
      .object({
        id: z.string(),
        prUrl: z.string().nullable(),
        prState: z.string().nullable(),
      })
      .parse(await createRes.json());
    expect(issue.prUrl).toBeNull();
    expect(issue.prState).toBeNull();

    const patchRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          prUrl: "https://github.com/VortexNYC/pile/pull/316",
          prState: "open",
        }),
      },
      token
    );
    expect(patchRes.status).toBe(200);
    const patched = z
      .object({
        prUrl: z.string().nullable(),
        prState: z.string().nullable(),
      })
      .parse(await patchRes.json());
    expect(patched).toEqual({
      prUrl: "https://github.com/VortexNYC/pile/pull/316",
      prState: "open",
    });

    const clearedRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ prUrl: null, prState: null }),
      },
      token
    );
    expect(clearedRes.status).toBe(200);
    const cleared = z
      .object({
        prUrl: z.string().nullable(),
        prState: z.string().nullable(),
      })
      .parse(await clearedRes.json());
    expect(cleared).toEqual({ prUrl: null, prState: null });
  });

  it("rejects a non-URL prUrl and a non-canonical prState via PATCH", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Validate PR link fields" }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await createRes.json());

    const badUrl = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ prUrl: "not-a-url" }),
      },
      token
    );
    expect(badUrl.status).toBe(400);

    const badState = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ prState: "in_review" }),
      },
      token
    );
    expect(badState.status).toBe(400);

    // A URL-shaped but non-http(s) link is not a PR.
    const badScheme = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ prUrl: "ftp://example.com/pr/1" }),
      },
      token
    );
    expect(badScheme.status).toBe(400);

    // prUrl is not GitHub-locked — GitLab MR URLs are legitimate links.
    const gitlab = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          prUrl: "https://gitlab.com/owner/repo/-/merge_requests/3",
          prState: "open",
        }),
      },
      token
    );
    expect(gitlab.status).toBe(200);
  });

  it("returns 409 when a PATCHed prUrl is claimed by another issue", async () => {
    const create = async (title: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        {
          method: "POST",
          body: JSON.stringify({ title }),
        },
        token
      );
      expect(res.status).toBe(201);
      return z.object({ id: z.string() }).parse(await res.json());
    };
    const owner = await create("Owns the PR link");
    const other = await create("Wants the same PR link");

    const claim = await fetch(
      `/workspaces/${organizationId}/issues/${owner.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          prUrl: "https://github.com/VortexNYC/pile/pull/999",
        }),
      },
      token
    );
    expect(claim.status).toBe(200);

    const conflict = await fetch(
      `/workspaces/${organizationId}/issues/${other.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          prUrl: "https://github.com/VortexNYC/pile/pull/999",
        }),
      },
      token
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects a batch patch that sets prUrl on multiple issues", async () => {
    const create = async (title: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        {
          method: "POST",
          body: JSON.stringify({ title }),
        },
        token
      );
      expect(res.status).toBe(201);
      return z.object({ id: z.string() }).parse(await res.json());
    };
    const first = await create("Batch first");
    const second = await create("Batch second");

    const res = await fetch(
      `/workspaces/${organizationId}/issues/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: [first.id, second.id],
          patch: { prUrl: "https://github.com/VortexNYC/pile/pull/500" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid resolution status combination", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Resolution with todo",
          status: "todo",
          resolution: "duplicate",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("captures a page to a triage issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/page",
          title: "Example page",
          selection: "selected text",
          source: "web-clipper",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = (await res.json()) as CaptureIssue;
    expect(issue.status).toBe("triage");
    expect(issue.title).toBe("Example page");
    expect(issue.description).toContain("https://example.com/page");
    expect(issue.description).toContain("selected text");
    expect(issue.description).toContain("web-clipper");
  });

  it("captures without a title using the url", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/untitled",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = (await res.json()) as CaptureIssue;
    expect(issue.title).toBe("https://example.com/untitled");
    expect(issue.status).toBe("triage");
  });

  it("rejects capture without a url", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({ title: "No url" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("captures a screenshot, summary, and full text", async () => {
    const pageText = [
      "Pile is an agent-native issue tracker. It runs on Cloudflare Workers.",
      "The clipper sends page context to triage. This line should be in the full text only.",
    ].join("\n\n");
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/screenshot",
          title: "Screenshot capture",
          source: "pile-clipper",
          pageText,
          summarize: true,
          includeFullText: true,
          screenshot: {
            contentType: "image/png",
            contentBase64: btoa(String.fromCharCode(...pngBytes)),
          },
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = z
      .object({ id: z.string(), description: z.string() })
      .parse(await res.json());
    expect(issue.description).toContain("**Summary**");
    expect(issue.description).toContain(
      "Pile is an agent-native issue tracker."
    );
    expect(issue.description).toContain("<details>");
    expect(issue.description).toContain(
      "This line should be in the full text only."
    );
    expect(issue.description).toContain("![Screenshot](");

    const attachmentsRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/attachments`,
      {},
      token
    );
    expect(attachmentsRes.status).toBe(200);
    const { attachments } = z
      .object({
        attachments: z.array(
          z.object({
            title: z.string().nullable(),
            url: z.string(),
            r2Key: z.string().nullable(),
          })
        ),
      })
      .parse(await attachmentsRes.json());
    expect(attachments).toHaveLength(1);
    expect(attachments[0].title).toBe("Screenshot");
    expect(attachments[0].r2Key).toMatch(
      new RegExp(`^${organizationId}/files/.+/screenshot\\.png$`)
    );
    const stored = await env.ATTACHMENTS_BUCKET.get(attachments[0].r2Key!);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(pngBytes);

    const fileRes = await fetch(attachments[0].url, {}, token);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/png");
  });

  it("rejects an invalid screenshot payload", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/bad-shot",
          screenshot: { contentType: "text/plain", contentBase64: "aGk=" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("routes a capture to a team, project, and labels", async () => {
    const teamRes = await fetch(
      `/workspaces/${organizationId}/teams`,
      {
        method: "POST",
        body: JSON.stringify({ key: "CLIP", name: "Clipper team" }),
      },
      token
    );
    expect(teamRes.status).toBe(201);
    const team = z.object({ id: z.string() }).parse(await teamRes.json());

    const projectRes = await fetch(
      `/workspaces/${organizationId}/projects`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Clipper project" }),
      },
      token
    );
    expect(projectRes.status).toBe(201);
    const project = z.object({ id: z.string() }).parse(await projectRes.json());

    const labelRes = await fetch(
      `/workspaces/${organizationId}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ name: "clipped", color: "#00ff00" }),
      },
      token
    );
    expect(labelRes.status).toBe(201);
    const label = z.object({ id: z.string() }).parse(await labelRes.json());

    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/routed",
          title: "Routed capture",
          teamKey: "clip",
          projectId: project.id,
          labelIds: [label.id, label.id],
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = z
      .object({
        teamId: z.string(),
        projectId: z.string().nullable(),
        labelIds: z.string().nullable(),
        identifier: z.string().nullable(),
        status: z.string(),
      })
      .parse(await res.json());
    expect(issue.teamId).toBe(team.id);
    expect(issue.projectId).toBe(project.id);
    expect(issue.labelIds).toBe(label.id);
    expect(issue.identifier).toMatch(/^CLIP-\d+$/);
    expect(issue.status).toBe("triage");
  });

  it("rejects capture routing to unknown targets", async () => {
    const unknownTeam = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/no-team",
          teamKey: "NOPE",
        }),
      },
      token
    );
    expect(unknownTeam.status).toBe(404);

    const unknownProject = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/no-project",
          projectId: "missing-project",
        }),
      },
      token
    );
    expect(unknownProject.status).toBe(404);

    const unknownLabel = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/no-label",
          labelIds: ["missing-label"],
        }),
      },
      token
    );
    expect(unknownLabel.status).toBe(404);
  });

  it("allows capture from a browser extension origin", async () => {
    const res = await app.fetch(
      new Request(`https://example.com/workspaces/${organizationId}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Origin: "chrome-extension://test-extension-id",
        },
        body: JSON.stringify({
          url: "https://example.com/extension-capture",
          title: "Extension capture",
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "chrome-extension://test-extension-id"
    );
    const issue = (await res.json()) as CaptureIssue;
    expect(issue.status).toBe("triage");
  });

  it("creates, reads publicly, and revokes an issue share", async () => {
    const createRes = await fetch(`/workspaces/${organizationId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Shareable issue",
        description: "shared body",
      }),
    }, token);
    expect(createRes.status).toBe(201);
    const issueId = ((await createRes.json()) as { id: string }).id;

    const shareRes = await fetch(
      `/workspaces/${organizationId}/issues/${issueId}/share`,
      { method: "POST", body: JSON.stringify({}) },
      token
    );
    expect(shareRes.status).toBe(201);
    const shareToken = ((await shareRes.json()) as { token: string }).token;

    const pub = await app.fetch(
      new Request(
        `https://example.com/shared-issues/${organizationId}/${shareToken}`
      ),
      env
    );
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as { issue: { title: string } };
    expect(body.issue.title).toBe("Shareable issue");

    await fetch(
      `/workspaces/${organizationId}/issues/${issueId}/share/${shareToken}`,
      { method: "DELETE" },
      token
    );
    const gone = await app.fetch(
      new Request(
        `https://example.com/shared-issues/${organizationId}/${shareToken}`
      ),
      env
    );
    expect(gone.status).toBe(404);
  });
});

describe("similar issues API", () => {
  it("ranks issues by title/description overlap and excludes the issue itself", async () => {
    const { organizationId, token } = await seedWorkspace();
    const create = async (title: string, description?: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/issues`,
        { method: "POST", body: JSON.stringify({ title, description }) },
        token
      );
      expect(res.status).toBe(201);
      return z
        .object({ id: z.string(), identifier: z.string() })
        .parse(await res.json());
    };
    const match = await create(
      "Webhook retries flood the delivery queue",
      "Outbound webhook retries never back off"
    );
    await create("Dark mode toggle in settings");
    const issue = await create(
      "Webhook delivery retries need backoff",
      "Retries hammer the queue"
    );

    const res = await fetch(
      `/workspaces/${organizationId}/issues/${issue.identifier}/similar?limit=5`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = z
      .object({
        similar: z.array(
          z.object({ issue: z.object({ id: z.string() }), score: z.number() })
        ),
      })
      .parse(await res.json());
    const ids = body.similar.map((hit) => hit.issue.id);
    expect(ids[0]).toBe(match.id);
    expect(ids).not.toContain(issue.id);

    const missing = await fetch(
      `/workspaces/${organizationId}/issues/NOPE-1/similar`,
      {},
      token
    );
    expect(missing.status).toBe(404);
  });
});

describe("possible duplicates on create (PILE-163)", () => {
  const duplicateSchema = z.object({
    id: z.string(),
    identifier: z.string().nullable(),
    title: z.string(),
    status: z.string(),
    score: z.number(),
  });
  const createdSchema = z.object({
    id: z.string(),
    possibleDuplicates: z.array(duplicateSchema),
  });

  it("returns similar open issues without blocking, and 409s with dedupe=block", async () => {
    const { organizationId, token } = await seedWorkspace();
    const create = async (body: Record<string, unknown>, query = "") =>
      fetch(
        `/workspaces/${organizationId}/issues${query}`,
        { method: "POST", body: JSON.stringify(body) },
        token
      );

    const firstRes = await create({
      title: "Webhook retries flood the delivery queue",
    });
    expect(firstRes.status).toBe(201);
    const first = createdSchema.parse(await firstRes.json());
    expect(first.possibleDuplicates).toEqual([]);

    const unrelated = createdSchema.parse(
      await (await create({ title: "Dark mode toggle in settings" })).json()
    );
    const closed = createdSchema.parse(
      await (
        await create({
          title: "Webhook retries flood the delivery queue",
          status: "canceled",
        })
      ).json()
    );

    const dupRes = await create({
      title: "Webhook retries flooding the delivery queue",
    });
    expect(dupRes.status).toBe(201);
    const dup = createdSchema.parse(await dupRes.json());
    const ids = dup.possibleDuplicates.map((hit) => hit.id);
    expect(ids[0]).toBe(first.id);
    expect(ids).not.toContain(unrelated.id);
    expect(ids).not.toContain(closed.id);
    expect(ids).not.toContain(dup.id);
    expect(dup.possibleDuplicates[0].score).toBeGreaterThanOrEqual(0.6);
    expect(dup.possibleDuplicates[0].score).toBeLessThanOrEqual(1);

    const blocked = await create(
      { title: "Webhook retries flood the delivery queue" },
      "?dedupe=block"
    );
    expect(blocked.status).toBe(409);
    const blockedBody = z
      .object({
        code: z.literal("CONFLICT"),
        details: z.object({ possibleDuplicates: z.array(duplicateSchema) }),
      })
      .parse(await blocked.json());
    const blockedIds = blockedBody.details.possibleDuplicates.map(
      (hit) => hit.id
    );
    expect(blockedIds).toContain(first.id);
    expect(blockedIds).toContain(dup.id);
    expect(blockedBody.details.possibleDuplicates[0].score).toBe(1);

    const list = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(
        await (
          await fetch(`/workspaces/${organizationId}/issues`, {}, token)
        ).json()
      );
    expect(list.issues).toHaveLength(4);

    const fresh = await create(
      { title: "Billing export ignores timezone offsets" },
      "?dedupe=block"
    );
    expect(fresh.status).toBe(201);
    expect(createdSchema.parse(await fresh.json()).possibleDuplicates).toEqual(
      []
    );
  });

  it("lets only one of two concurrent dedupe=block creates through", async () => {
    const { organizationId, token } = await seedWorkspace();
    const statuses = await Promise.all(
      [0, 1].map(async () => {
        const res = await fetch(
          `/workspaces/${organizationId}/issues?dedupe=block`,
          {
            method: "POST",
            body: JSON.stringify({
              title: "Search index drops archived documents",
            }),
          },
          token
        );
        return res.status;
      })
    );
    expect(statuses.toSorted()).toEqual([201, 409]);
  });

  it("returns the existing issue on externalRef replay, even with dedupe=block", async () => {
    const { organizationId, token } = await seedWorkspace();
    const externalRef = `test:${crypto.randomUUID()}`;
    const create = async (body: Record<string, unknown>, query = "") =>
      fetch(
        `/workspaces/${organizationId}/issues${query}`,
        { method: "POST", body: JSON.stringify(body) },
        token
      );

    const firstRes = await create({
      title: "Retry storm exhausts worker budget",
      externalRef,
    });
    expect(firstRes.status).toBe(201);
    const first = z.object({ id: z.string() }).parse(await firstRes.json());

    // A near-identical title means a fresh create would hit duplicates.
    const dupRes = await create({
      title: "Retry storm exhausts the worker budget",
    });
    expect(dupRes.status).toBe(201);

    for (const query of ["?dedupe=block", "?dedupe=warn"]) {
      const replay = await create(
        { title: "Retry storm exhausts worker budget", externalRef },
        query
      );
      expect(replay.status).toBe(200);
      const body = (await replay.json()) as {
        id: string;
        possibleDuplicates?: unknown;
      };
      expect(body.id).toBe(first.id);
      expect(body.possibleDuplicates).toBeUndefined();
    }
  });

  // PILE-321 — assigning an agent to a repo-less issue dispatches a lane
  // that inherits the team's defaultRepo and persists it on the issue.
  it("inherits the team's defaultRepo when an agent assignee dispatches", async () => {
    const { organizationId, token } = await seedWorkspace();
    const db = createD1(env.D1);
    const teamRepo = "VortexNYC/assign-default";
    const team = await createTeam(db, env, new Headers(), {
      organizationId,
      key: `A${crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      name: "Assign default",
      ownerId: "user-issues",
      defaultRepo: teamRepo,
    });
    const auth = await createAuth(env);
    const keyResult = await auth.api.createApiKey({
      body: {
        userId: "user-issues",
        name: "assign-agent",
        metadata: {
          organizationId,
          permissions: "admin,agent:write",
          actorType: "agent",
        },
      },
    });
    const agentToken = z.object({ key: z.string() }).parse(keyResult).key;

    const agentId = `mock-assign-${crypto.randomUUID().slice(0, 8)}`;
    let seenRepo: string | null | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            seenRepo = dispatchedIssue.repo;
            return {
              id: `assign-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Assign dispatches onto the default repo",
          teamId: team.id,
          repo: null,
        }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z
      .object({ id: z.string(), repo: z.string().nullable() })
      .parse(await createRes.json());
    expect(issue.repo).toBeNull();

    const assignRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/assign`,
      { method: "POST", body: JSON.stringify({ assigneeId: agentId }) },
      agentToken
    );
    expect(assignRes.status).toBe(200);
    const assigned = z
      .object({ session: z.object({ id: z.string() }).optional() })
      .parse(await assignRes.json());
    expect(assigned.session?.id).toBeTruthy();
    expect(seenRepo).toBe(teamRepo);

    const getRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}`,
      {},
      token
    );
    expect(getRes.status).toBe(200);
    const fetched = z
      .object({ repo: z.string().nullable() })
      .parse(await getRes.json());
    expect(fetched.repo).toBe(teamRepo);
  });
});
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  gitlabInstallations,
  repoIssues,
  user as userTable,
} from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { processGitlabWebhookPayload } from "./gitlab.js";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

let organizationId: string;
const projectPath = "vortexnyc/issuetracker";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: userTable.email });
  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "GitLab test workspace",
    slug: `gitlab-test-${crypto.randomUUID()}`,
    key: `G${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  organizationId = workspace!.id;

  const installationNow = new Date();
  await db.insert(gitlabInstallations).values({
    id: crypto.randomUUID(),
    organizationId,
    projectId: "123",
    projectPath,
    token: "glpat-fake",
    webhookSecret: "secret",
    createdAt: installationNow.toISOString(),
    updatedAt: installationNow.toISOString(),
  });
});

function makeIssuePayload(
  overrides: { action?: string; updatedAt?: string } = {}
) {
  const action = overrides.action ?? "open";
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  return {
    object_kind: "issue",
    event_type: "issue",
    project: { id: "123", path_with_namespace: projectPath },
    object_attributes: {
      id: "123",
      iid: 1,
      title: "GitLab bug",
      description: "A bug from GitLab",
      state: action === "open" ? "opened" : "closed",
      action,
      url: "https://gitlab.com/vortexnyc/issuetracker/-/issues/1",
      created_at: updatedAt,
      updated_at: updatedAt,
      assignees: [],
      labels: [],
      milestone: null,
    },
  };
}

describe("processGitlabWebhookPayload", () => {
  it("creates a repo issue for an open event", async () => {
    const db = createD1(env.D1);
    const payload = makeIssuePayload();
    await processGitlabWebhookPayload(db, env, {
      organizationId,
      rawBody: JSON.stringify(payload),
    });

    const mapping = await db
      .select()
      .from(repoIssues)
      .where(eq(repoIssues.repo, projectPath))
      .get();
    expect(mapping).toBeDefined();
    expect(mapping?.issueNumber).toBe(1);
  });

  it("does not duplicate a repo issue when the same open event is replayed", async () => {
    const db = createD1(env.D1);
    const payload = makeIssuePayload();
    await processGitlabWebhookPayload(db, env, {
      organizationId,
      rawBody: JSON.stringify(payload),
    });
    await processGitlabWebhookPayload(db, env, {
      organizationId,
      rawBody: JSON.stringify(payload),
    });

    const rows = await db
      .select()
      .from(repoIssues)
      .where(eq(repoIssues.repo, projectPath))
      .all();
    expect(rows.length).toBe(1);
  });
});

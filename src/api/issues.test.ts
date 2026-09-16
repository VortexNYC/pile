import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
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

  const auth = createAuth(env);
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
  });

  it("rejects listing issues without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/issues`);
    expect(res.status).toBe(401);
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
});

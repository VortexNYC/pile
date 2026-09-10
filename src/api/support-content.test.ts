import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-content",
      name: "Content User",
      email: "content-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-content");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support content test",
    slug: `support-content-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-content",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-content",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

describe("support-content API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  it("creates and lists support snippets", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "greeting",
          textContent: "Hello, how can we help?",
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      snippet: {
        name: string;
        textContent: string;
        markdownContent: string | null;
      };
    };
    expect(createBody.snippet.name).toBe("greeting");
    expect(createBody.snippet.textContent).toBe("Hello, how can we help?");
    expect(createBody.snippet.markdownContent).toBeNull();

    const listRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      snippets: { name: string }[];
    };
    expect(listBody.snippets).toHaveLength(1);
    expect(listBody.snippets[0].name).toBe("greeting");
  });

  it("creates and lists support autoresponders", async () => {
    const snippetRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "thanks",
          textContent: "Thanks for reaching out.",
        }),
      }
    );
    expect(snippetRes.status).toBe(201);
    const { snippet } = (await snippetRes.json()) as {
      snippet: { id: string };
    };

    const createRes = await fetch(
      `/workspaces/${organizationId}/support/autoresponders`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "new ticket reply",
          trigger: "ticket_created",
          order: 1,
          snippetId: snippet.id,
          conditions: { sourceChannel: "email" },
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      autoresponder: {
        name: string;
        trigger: string;
        snippetId: string | null;
        conditions: Record<string, string>;
      };
    };
    expect(createBody.autoresponder.name).toBe("new ticket reply");
    expect(createBody.autoresponder.trigger).toBe("ticket_created");
    expect(createBody.autoresponder.snippetId).toBe(snippet.id);
    expect(createBody.autoresponder.conditions).toEqual({
      sourceChannel: "email",
    });

    const listRes = await fetch(
      `/workspaces/${organizationId}/support/autoresponders`
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      autoresponders: { name: string }[];
    };
    expect(listBody.autoresponders).toHaveLength(1);
    expect(listBody.autoresponders[0].name).toBe("new ticket reply");
  });
});

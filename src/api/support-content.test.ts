import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createCustomer } from "../global/support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  getTicketById,
} from "../global/support-tickets.js";
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

  it("gets and patches a support snippet", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "faq",
          textContent: "Question",
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const { snippet } = (await createRes.json()) as {
      snippet: { id: string };
    };

    const getRes = await fetch(
      `/workspaces/${organizationId}/support/snippets/${snippet.id}`
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      snippet: { name: string; textContent: string };
    };
    expect(getBody.snippet.name).toBe("faq");

    const patchRes = await fetch(
      `/workspaces/${organizationId}/support/snippets/${snippet.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: "faq-updated",
          markdownContent: "# Answer",
        }),
      }
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      snippet: { name: string; markdownContent: string | null };
    };
    expect(patchBody.snippet.name).toBe("faq-updated");
    expect(patchBody.snippet.markdownContent).toBe("# Answer");
  });

  it("inserts a support snippet", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "signature",
          textContent: "Best regards, Vortex",
          markdownContent: "**Best regards, Vortex**",
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const { snippet } = (await createRes.json()) as {
      snippet: { id: string };
    };

    const insertRes = await fetch(
      `/workspaces/${organizationId}/support/snippets/${snippet.id}/insert`,
      { method: "POST" }
    );
    expect(insertRes.status).toBe(200);
    const insertBody = (await insertRes.json()) as {
      text: string;
      markdown: string | null;
    };
    expect(insertBody.text).toBe("Best regards, Vortex");
    expect(insertBody.markdown).toBe("**Best regards, Vortex**");
  });

  it("triggers autoresponders on ticket creation and customer reply", async () => {
    const db = createD1(env.D1);
    const customer = await createCustomer(db, {
      organizationId,
      email: "autoresponder@example.com",
      fullName: "Autoresponder Customer",
    });

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

    const ticketCreatedRes = await fetch(
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
    expect(ticketCreatedRes.status).toBe(201);

    const customerRepliedRes = await fetch(
      `/workspaces/${organizationId}/support/autoresponders`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "follow-up",
          trigger: "customer_replied",
          order: 2,
          snippetId: snippet.id,
        }),
      }
    );
    expect(customerRepliedRes.status).toBe(201);

    const ticket = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "Help",
      sourceChannel: "email",
    });

    const fullAfterCreate = await getTicketById(db, organizationId, ticket.id);
    const autoCreated = fullAfterCreate?.events.filter(
      (e) =>
        e.actorType === "automation" &&
        e.message?.textContent === "Thanks for reaching out."
    );
    expect(autoCreated).toHaveLength(1);

    await addTicketMessage(db, organizationId, ticket.id, {
      direction: "inbound",
      textContent: "Still broken",
      channel: "email",
      customerId: customer.id,
    });

    const fullAfterReply = await getTicketById(db, organizationId, ticket.id);
    const autoReplied = fullAfterReply?.events.filter(
      (e) =>
        e.actorType === "automation" &&
        e.message?.textContent === "Thanks for reaching out."
    );
    expect(autoReplied).toHaveLength(2);
  });

  it("creates and lists support autoresponders", async () => {
    const snippetRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "thanks2",
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
    expect(listBody.autoresponders.length).toBeGreaterThan(0);
  });

  it("patches a support autoresponder", async () => {
    const snippetRes = await fetch(
      `/workspaces/${organizationId}/support/snippets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "welcome",
          textContent: "Welcome.",
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
          name: "follow-up",
          trigger: "customer_replied",
          order: 1,
          snippetId: snippet.id,
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const { autoresponder } = (await createRes.json()) as {
      autoresponder: { id: string };
    };

    const patchRes = await fetch(
      `/workspaces/${organizationId}/support/autoresponders/${autoresponder.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          enabled: false,
          order: 2,
          conditions: { priority: "high" },
        }),
      }
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      autoresponder: {
        enabled: boolean;
        order: number;
        conditions: Record<string, string>;
      };
    };
    expect(patchBody.autoresponder.enabled).toBe(false);
    expect(patchBody.autoresponder.order).toBe(2);
    expect(patchBody.autoresponder.conditions).toEqual({ priority: "high" });
  });

  it("creates and lists support labels", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/support/labels`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "premium",
          color: "#ff0000",
        }),
      }
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      label: {
        name: string;
        color: string | null;
        kind: string;
      };
    };
    expect(createBody.label.name).toBe("premium");
    expect(createBody.label.color).toBe("#ff0000");
    expect(createBody.label.kind).toBe("support");

    const listRes = await fetch(`/workspaces/${organizationId}/support/labels`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      labels: { name: string }[];
    };
    expect(listBody.labels).toHaveLength(1);
    expect(listBody.labels[0].name).toBe("premium");
  });

  it("rejects creating a label without auth", async () => {
    const res = await app.fetch(
      new Request(
        `https://example.com/workspaces/${organizationId}/support/labels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "no auth" }),
        }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects listing labels without auth", async () => {
    const res = await app.fetch(
      new Request(
        `https://example.com/workspaces/${organizationId}/support/labels`
      ),
      env
    );
    expect(res.status).toBe(401);
  });

  it("rejects creating a label without a name", async () => {
    const res = await fetch(`/workspaces/${organizationId}/support/labels`, {
      method: "POST",
      body: JSON.stringify({ color: "#ff0000" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects creating a label with a non-string color", async () => {
    const res = await fetch(`/workspaces/${organizationId}/support/labels`, {
      method: "POST",
      body: JSON.stringify({
        name: "bad color",
        color: 123,
      }),
    });
    expect(res.status).toBe(400);
  });
});

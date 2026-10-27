import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { createD1 } from "../global/db.js";
import { apikey, member, verification } from "../global/schema.js";
import { listWorkspacesForUser } from "../global/workspaces.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { captureProductEvent } from "../platform/posthog.js";
import { rls } from "../platform/rls.js";
import { getSessionUserId } from "../platform/session.js";

const oauthClientSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.string()),
  permissions: z.string(),
  createdAt: z.string(),
});

const oauthClientWithSecretSchema = oauthClientSchema.extend({
  clientId: z.string(),
  clientSecret: z.string(),
});

const oauthClientBodySchema = z.object({
  name: z.string().min(1),
  redirectUris: z.array(z.string().url()).default([]),
  scopes: z.array(z.string()).default([]),
  permissions: z.string().default("read"),
});

const oauthClientUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  redirectUris: z.array(z.string().url()).optional(),
  scopes: z.array(z.string()).optional(),
  permissions: z.string().optional(),
});

const oauthClientMetadataSchema = z.object({
  organizationId: z.string(),
  permissions: z.string(),
  actorType: z.literal("oauth-client"),
  redirectUris: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
});

function parseMetadata(metadata: unknown) {
  if (typeof metadata === "string") {
    return oauthClientMetadataSchema.parse(JSON.parse(metadata));
  }
  return oauthClientMetadataSchema.parse(metadata);
}

const listOAuthClientsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/oauth-clients",
  tags: ["oauth-clients"],
  middleware: [rls("settings:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "OAuth clients list",
      content: {
        "application/json": {
          schema: z.object({ clients: z.array(oauthClientSchema) }),
        },
      },
    },
  },
});

const createOAuthClientRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/oauth-clients",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: oauthClientBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "OAuth client created",
      content: {
        "application/json": { schema: oauthClientWithSecretSchema },
      },
    },
  },
});

const getOAuthClientRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("settings:view")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "OAuth client",
      content: {
        "application/json": { schema: oauthClientSchema },
      },
    },
    404: { description: "OAuth client not found" },
  },
});

const updateOAuthClientRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: oauthClientUpdateSchema },
      },
    },
  },
  responses: {
    200: {
      description: "OAuth client updated",
      content: {
        "application/json": { schema: oauthClientSchema },
      },
    },
    404: { description: "OAuth client not found" },
  },
});

const deleteOAuthClientRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/oauth-clients/{id}",
  tags: ["oauth-clients"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "OAuth client deleted" },
  },
});

function toClient(
  row: typeof apikey.$inferSelect
): z.infer<typeof oauthClientSchema> {
  const parsed = parseMetadata(row.metadata);
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt);
  return {
    id: row.id,
    organizationId: parsed.organizationId,
    name: row.name ?? "",
    redirectUris: parsed.redirectUris,
    scopes: parsed.scopes,
    permissions: parsed.permissions,
    createdAt,
  };
}

export function registerOAuthClientRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listOAuthClientsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const rows = await db.select().from(apikey).all();
    const clients = rows
      .filter((row) => {
        try {
          const parsed = parseMetadata(row.metadata);
          return parsed.organizationId === organizationId;
        } catch {
          return false;
        }
      })
      .map(toClient);
    return c.json({ clients });
  });

  app.openapi(createOAuthClientRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const auth = await createAuth(c.env);

    const result = await auth.api.createApiKey({
      body: {
        userId: identity.id,
        name: input.name,
        rateLimitEnabled: false,
        metadata: {
          organizationId,
          permissions: input.permissions,
          actorType: "oauth-client",
          redirectUris: input.redirectUris,
          scopes: input.scopes,
        },
        permissions: {
          workspace: input.permissions
            .split(",")
            .map((p: string) => p.trim())
            .filter(Boolean),
        },
      },
    });

    const parsed = z
      .object({
        id: z.string(),
        key: z.string(),
        name: z.string().nullable(),
        createdAt: z.union([z.date(), z.string()]),
      })
      .parse(result);

    return c.json(
      {
        id: parsed.id,
        organizationId,
        name: parsed.name ?? input.name,
        clientId: parsed.id,
        clientSecret: parsed.key,
        redirectUris: input.redirectUris,
        scopes: input.scopes,
        permissions: input.permissions,
        createdAt:
          parsed.createdAt instanceof Date
            ? parsed.createdAt.toISOString()
            : parsed.createdAt,
      },
      201
    );
  });

  app.openapi(getOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const parsed = parseMetadata(row.metadata);
    if (parsed.organizationId !== organizationId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    return c.json(toClient(row));
  });

  app.openapi(updateOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const parsed = parseMetadata(row.metadata);
    if (parsed.organizationId !== organizationId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "OAuth client not found",
      });
    }
    const next = {
      ...parsed,
      permissions: input.permissions ?? parsed.permissions,
      redirectUris: input.redirectUris ?? parsed.redirectUris,
      scopes: input.scopes ?? parsed.scopes,
    };
    await db
      .update(apikey)
      .set({
        name: input.name ?? row.name,
        metadata: JSON.stringify(next),
      })
      .where(eq(apikey.id, id));
    return c.json(
      toClient({
        ...row,
        name: input.name ?? row.name,
        metadata: JSON.stringify(next),
      })
    );
  });

  app.openapi(deleteOAuthClientRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const row = await db.select().from(apikey).where(eq(apikey.id, id)).get();
    if (row) {
      const parsed = parseMetadata(row.metadata);
      if (parsed.organizationId === organizationId) {
        await db.delete(apikey).where(eq(apikey.id, id));
      }
    }
    return c.body(null, 204);
  });
}

// ---------------------------------------------------------------------------
// PILE-620 — OAuth 2.0 authorization server + PKCE flow so MCP connectors
// (Claude, Cursor, ChatGPT) can do standards-based interactive sign-in
// instead of pasting static API keys.
// ---------------------------------------------------------------------------

const MCP_SCOPES = ["read", "write", "admin", "agent:read", "agent:write"];

function originOf(url: string) {
  return new URL(url).origin;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface OAuthRegistration {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scope?: string;
  tokenEndpointAuthMethod?: string;
}

interface OAuthCodeRecord {
  userId: string;
  organizationId: string;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string;
  scope: string;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type OAuthContext = Context<AppContext>;

async function resolveOAuthIdentity(
  c: OAuthContext
): Promise<
  | { kind: "token"; organizationId: string }
  | { kind: "user"; userId: string }
  | null
> {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const auth = await createAuth(c.env);
    try {
      const result = await auth.api.verifyApiKey({
        body: { key: authHeader.slice(7) },
      });
      const metadata = result?.key?.metadata;
      if (result?.valid && typeof metadata === "string" && metadata) {
        const meta = JSON.parse(metadata) as { organizationId?: string };
        if (meta.organizationId) {
          return { kind: "token", organizationId: meta.organizationId };
        }
      }
    } catch {
      // fall through to session auth
    }
  }
  const userId = await getSessionUserId(c.env, c.req.raw).catch(() => null);
  if (userId) return { kind: "user", userId };
  return null;
}

async function readOAuthBody(c: OAuthContext): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await c.req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const json = (await c.req.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).map(([k, v]) => [k, String(v ?? "")])
    );
  } catch {
    return {};
  }
}

// Shared authorize logic for GET (consent page / approve=1) and POST.
const handleAuthorize = async (c: OAuthContext, approved: boolean) => {
  const body = approved ? await readOAuthBody(c) : {};
  const param = (name: string) => body[name] ?? c.req.query(name) ?? null;

  const clientId = param("client_id");
  const redirectUri = param("redirect_uri");
  const state = param("state");
  const codeChallenge = param("code_challenge");
  const codeChallengeMethod = param("code_challenge_method") ?? "S256";
  const scope = param("scope") ?? "read,write";
  const organizationId = param("organization_id");

  const identity = await resolveOAuthIdentity(c);
  if (!identity) {
    return c.redirect(`/app/sign-in?redirect=${encodeURIComponent(c.req.url)}`);
  }

  const db = createD1(c.env.D1);

  // Resolve the workspace choices the caller can grant to.
  let orgChoices: Array<{ id: string; name: string }> = [];
  if (identity.kind === "token") {
    orgChoices = [
      { id: identity.organizationId, name: identity.organizationId },
    ];
  } else {
    const rows = await listWorkspacesForUser(db, identity.userId).catch(
      () => [] as Array<{ id: string; name?: string | null }>
    );
    orgChoices = rows.map((w) => ({
      id: w.id,
      name: w.name ?? w.id,
    }));
  }
  const targetOrg = organizationId ?? orgChoices[0]?.id ?? null;

  if (!approved) {
    const options = orgChoices
      .map(
        (o) =>
          `<option value="${escapeHtml(o.id)}"${o.id === targetOrg ? " selected" : ""}>${escapeHtml(o.name)}</option>`
      )
      .join("");
    const hidden = (k: string, v: string | null) =>
      v === null
        ? ""
        : `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
    return c.html(`<!doctype html><html><head><title>Authorize ${escapeHtml(clientId ?? "MCP connector")} — Pile</title>
<style>body{font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}button{background:#111;color:#fff;border:0;border-radius:.5rem;padding:.6rem 1.4rem;font-size:1rem;cursor:pointer}select{width:100%;padding:.5rem;margin:.5rem 0 1.5rem}.card{border:1px solid #ddd;border-radius:.75rem;padding:1.5rem}</style>
</head><body><div class="card">
<h1>Authorize access</h1>
<p><strong>${escapeHtml(clientId ?? "An MCP connector")}</strong> is requesting <code>${escapeHtml(scope)}</code> access to a Pile workspace.</p>
<form method="post" action="/oauth/authorize">
${hidden("client_id", clientId)}${hidden("redirect_uri", redirectUri)}${hidden("state", state)}${hidden("code_challenge", codeChallenge)}${hidden("code_challenge_method", codeChallengeMethod)}${hidden("scope", scope)}
<label>Workspace<br><select name="organization_id">${options}</select></label>
<button type="submit">Approve</button>
</form></div></body></html>`);
  }

  // Approved — validate and mint the code.
  if (!targetOrg) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "organization_id is required",
      },
      400
    );
  }
  if (identity.kind === "token" && identity.organizationId !== targetOrg) {
    return c.json(
      {
        error: "access_denied",
        error_description: "Token is not scoped to that workspace",
      },
      403
    );
  }
  if (identity.kind === "user") {
    const membership = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.userId, identity.userId),
          eq(member.organizationId, targetOrg)
        )
      )
      .get();
    if (!membership) {
      return c.json(
        {
          error: "access_denied",
          error_description: "Not a member of that workspace",
        },
        403
      );
    }
  }

  // Validate redirect_uri against a registered client when we have one.
  if (clientId) {
    const reg = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `oauth_reg:${clientId}`))
      .get();
    if (reg) {
      const parsed = JSON.parse(reg.value) as OAuthRegistration;
      if (
        parsed.redirectUris.length > 0 &&
        redirectUri &&
        !parsed.redirectUris.includes(redirectUri)
      ) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "redirect_uri is not registered",
          },
          400
        );
      }
    }
  }
  if (!redirectUri) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "redirect_uri is required",
      },
      400
    );
  }

  const code = `pile_code_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: `oauth_code:${code}`,
    value: JSON.stringify({
      userId:
        identity.kind === "user"
          ? identity.userId
          : `token:${identity.organizationId}`,
      organizationId: targetOrg,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
    } satisfies OAuthCodeRecord),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const sep = redirectUri.includes("?") ? "&" : "?";
  const target = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
  return c.redirect(target, 302);
};

export function registerOAuthRoutes(app: OpenAPIHono<AppContext>) {
  // Discovery metadata — public.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = originOf(c.req.url);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: MCP_SCOPES,
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    const origin = originOf(c.req.url);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: MCP_SCOPES,
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = originOf(c.req.url);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      code_challenge_methods_supported: ["S256", "plain"],
      scopes_supported: MCP_SCOPES,
    });
  });

  // Dynamic client registration (RFC 7591) for MCP connectors.
  app.post("/oauth/register", async (c) => {
    let input: Record<string, unknown>;
    try {
      input = (await c.req.json()) as Record<string, unknown>;
    } catch {
      input = {};
    }
    const clientId = `mcp_client_${crypto.randomUUID().replace(/-/g, "")}`;
    const clientName = String(input.client_name ?? "MCP Connector");
    const redirectUris = Array.isArray(input.redirect_uris)
      ? input.redirect_uris.map(String)
      : [];
    const scope = typeof input.scope === "string" ? input.scope : undefined;
    const tokenEndpointAuthMethod =
      typeof input.token_endpoint_auth_method === "string"
        ? input.token_endpoint_auth_method
        : undefined;

    const db = createD1(c.env.D1);
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: `oauth_reg:${clientId}`,
      value: JSON.stringify({
        clientId,
        clientName,
        redirectUris,
        scope,
        tokenEndpointAuthMethod,
      } satisfies OAuthRegistration),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return c.json(
      {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: tokenEndpointAuthMethod ?? "none",
      },
      201
    );
  });

  app.get("/oauth/authorize", async (c) =>
    handleAuthorize(c, c.req.query("approve") === "1")
  );
  app.post("/oauth/authorize", async (c) => handleAuthorize(c, true));

  app.post("/oauth/token", async (c) => {
    const body = await readOAuthBody(c);
    const basic = c.req.header("authorization");
    let basicId: string | null = null;
    let basicSecret: string | null = null;
    if (basic?.startsWith("Basic ")) {
      try {
        const decoded = atob(basic.slice(6));
        const idx = decoded.indexOf(":");
        basicId = decoded.slice(0, idx);
        basicSecret = decoded.slice(idx + 1);
      } catch {
        // ignore malformed basic auth
      }
    }
    const grantType = body.grant_type ?? null;

    if (grantType === "authorization_code") {
      const code = body.code;
      if (!code) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "code is required",
          },
          400
        );
      }
      const db = createD1(c.env.D1);
      const row = await db
        .select()
        .from(verification)
        .where(eq(verification.identifier, `oauth_code:${code}`))
        .get();
      // Single-use — delete before validating anything else.
      if (row) {
        await db.delete(verification).where(eq(verification.id, row.id));
      }
      if (!row || row.expiresAt.getTime() <= Date.now()) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "Invalid or expired authorization code",
          },
          400
        );
      }
      const stored = JSON.parse(row.value) as OAuthCodeRecord;
      if (
        stored.redirectUri &&
        body.redirect_uri &&
        body.redirect_uri !== stored.redirectUri
      ) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "redirect_uri mismatch",
          },
          400
        );
      }
      if (stored.codeChallenge) {
        const verifier = body.code_verifier;
        if (!verifier) {
          return c.json(
            {
              error: "invalid_grant",
              error_description: "code_verifier is required",
            },
            400
          );
        }
        let ok = false;
        if (stored.codeChallengeMethod === "plain") {
          ok = verifier === stored.codeChallenge;
        } else {
          ok = (await sha256Base64Url(verifier)) === stored.codeChallenge;
        }
        if (!ok) {
          return c.json(
            {
              error: "invalid_grant",
              error_description: "PKCE verification failed",
            },
            400
          );
        }
      }

      const auth = await createAuth(c.env);
      const permissions = stored.scope.split(/[,\s]+/).filter(Boolean);
      let userId = stored.userId;
      if (userId.startsWith("token:")) {
        // Token-identity authorization: mint under the workspace owner.
        const orgRow = await db
          .select({ id: member.id, userId: member.userId })
          .from(member)
          .where(
            and(
              eq(member.organizationId, stored.organizationId),
              eq(member.role, "owner")
            )
          )
          .get();
        if (!orgRow) {
          return c.json(
            {
              error: "invalid_grant",
              error_description: "Workspace has no owner",
            },
            400
          );
        }
        userId = orgRow.userId;
      }
      const result = await auth.api.createApiKey({
        body: {
          userId,
          name: `oauth-${(stored.clientId ?? "connector").slice(0, 16)}`,
          metadata: {
            organizationId: stored.organizationId,
            permissions: stored.scope,
            actorType: "user",
          },
          permissions: { workspace: permissions },
        },
      });
      const parsed = result as { key?: string };
      captureProductEvent(
        "oauth.token_issued",
        {
          organizationId: stored.organizationId,
          actorId: userId,
          clientId: stored.clientId,
          grantType: "authorization_code",
          scope: stored.scope,
        },
        undefined,
        { env: c.env }
      );
      return c.json({
        access_token: parsed.key,
        token_type: "Bearer",
        scope: stored.scope,
        organization_id: stored.organizationId,
      });
    }

    if (grantType === "client_credentials") {
      const clientId = body.client_id ?? basicId;
      const clientSecret = body.client_secret ?? basicSecret;
      if (!clientId || !clientSecret) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "client_id and client_secret are required",
          },
          400
        );
      }
      const auth = await createAuth(c.env);
      let key: { id?: string; metadata?: string | null } | null = null;
      try {
        const result = await auth.api.verifyApiKey({
          body: { key: clientSecret },
        });
        const verifiedKey = result?.key as
          | { id?: string; metadata?: string | null }
          | null
          | undefined;
        if (result?.valid && verifiedKey) key = verifiedKey;
      } catch {
        key = null;
      }
      if (!key || key.id !== clientId) {
        return c.json({ error: "invalid_client" }, 401);
      }
      const meta = JSON.parse(key.metadata ?? "{}") as {
        organizationId?: string;
        permissions?: string;
      };
      captureProductEvent(
        "oauth.token_issued",
        {
          organizationId: meta.organizationId,
          clientId,
          grantType: "client_credentials",
          scope: meta.permissions ?? "read",
        },
        undefined,
        { env: c.env }
      );
      return c.json({
        access_token: clientSecret,
        token_type: "Bearer",
        scope: meta.permissions ?? "read",
        organization_id: meta.organizationId,
      });
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });
}

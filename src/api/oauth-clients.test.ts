import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const ORIGIN = "http://localhost";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "oauth-user-1",
      name: "OAuth Test User",
      email: "oauth-user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "oauth-user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "OAuth test workspace",
    slug: `oauth-${crypto.randomUUID()}`,
    key: `O${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "oauth-user-1",
  });
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "oauth-user-1",
      name: "oauth-test-admin",
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
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

describe("oauth discovery metadata", () => {
  it("serves protected resource and authorization server metadata", async () => {
    const prm = await app.fetch(
      new Request("http://localhost/.well-known/oauth-protected-resource"),
      env
    );
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
      scopes_supported: string[];
    };
    expect(prmBody.resource).toBe("http://localhost/mcp");
    expect(prmBody.authorization_servers).toEqual(["http://localhost"]);
    expect(prmBody.bearer_methods_supported).toEqual(["header"]);
    expect(prmBody.scopes_supported).toContain("admin");

    const prmMcp = await app.fetch(
      new Request("http://localhost/.well-known/oauth-protected-resource/mcp"),
      env
    );
    expect(prmMcp.status).toBe(200);

    const asMeta = await app.fetch(
      new Request("http://localhost/.well-known/oauth-authorization-server"),
      env
    );
    expect(asMeta.status).toBe(200);
    const asBody = (await asMeta.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
    };
    expect(asBody.issuer).toBe("http://localhost");
    expect(asBody.authorization_endpoint).toBe(
      "http://localhost/oauth/authorize"
    );
    expect(asBody.token_endpoint).toBe("http://localhost/oauth/token");
    expect(asBody.registration_endpoint).toBe(
      "http://localhost/oauth/register"
    );
    expect(asBody.grant_types_supported).toContain("authorization_code");
    expect(asBody.code_challenge_methods_supported).toContain("S256");
  });

  it("serves the agent kit discovery manifest", async () => {
    const res = await app.fetch(
      new Request("http://localhost/.well-known/mcp.json"),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      mcpEndpoint: string;
      oauthProtectedResource: string;
      oauthAuthorizationServer: string;
      skills: string[];
      prompts: string[];
      resources: string[];
    };
    expect(body.name).toBe("pile");
    expect(body.version).toBe("0.1.1");
    expect(body.mcpEndpoint).toBe("http://localhost/mcp");
    expect(body.oauthProtectedResource).toBe(
      "http://localhost/.well-known/oauth-protected-resource"
    );
    expect(body.oauthAuthorizationServer).toBe(
      "http://localhost/.well-known/oauth-authorization-server"
    );
    expect(body.skills).toEqual([
      "pile-mcp",
      "pile-cli",
      "pile-sdk",
      "pile-agent",
    ]);
    expect(body.prompts).toEqual([
      "triage-issue",
      "morning-brief",
      "session-handoff",
      "memory-distill",
    ]);
    expect(body.resources).toContain(
      "pile://workspaces/{organizationId}/issues/{id}"
    );
  });
});

describe("oauth authorization code + PKCE flow", () => {
  it("registers a client, authorizes, and exchanges the code", async () => {
    const { organizationId, token } = await seedWorkspace();
    const redirectUri = "http://connector.example.com/callback";

    // 1. Dynamic client registration.
    const regRes = await app.fetch(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          client_name: "Test Connector",
          redirect_uris: [redirectUri],
        }),
      }),
      env
    );
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as {
      client_id: string;
      token_endpoint_auth_method: string;
    };
    expect(reg.client_id).toMatch(/^mcp_client_/);
    expect(reg.token_endpoint_auth_method).toBe("none");

    // 2. Authorize — workspace Bearer token identity, POST approval.
    const verifier = `v${crypto.randomUUID().replace(/-/g, "")}`;
    const challenge = await sha256Base64Url(verifier);
    const authRes = await app.fetch(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${token}`,
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: reg.client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          state: "st-123",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "read,write",
          organization_id: organizationId,
        }).toString(),
      }),
      env
    );
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("location") ?? "";
    const redirect = new URL(location);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectUri);
    const code = redirect.searchParams.get("code") ?? "";
    expect(code).toMatch(/^pile_code_/);
    expect(redirect.searchParams.get("state")).toBe("st-123");

    // 3. Wrong verifier fails.
    const badRes = await app.fetch(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: "wrong-verifier",
        }).toString(),
      }),
      env
    );
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string };
    expect(badBody.error).toBe("invalid_grant");

    // Code was consumed by the failed attempt — mint another.
    const authRes2 = await app.fetch(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${token}`,
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: reg.client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "read,write",
          organization_id: organizationId,
        }).toString(),
      }),
      env
    );
    const code2 = new URL(
      authRes2.headers.get("location") ?? ""
    ).searchParams.get("code") as string;

    // 4. Correct verifier succeeds.
    const tokenRes = await app.fetch(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }),
      env
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      organization_id: string;
    };
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.organization_id).toBe(organizationId);
    expect(tokenBody.access_token).toBeTruthy();

    // 5. Replay fails — the code is single-use.
    const replayRes = await app.fetch(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }),
      env
    );
    expect(replayRes.status).toBe(400);
    const replayBody = (await replayRes.json()) as { error: string };
    expect(replayBody.error).toBe("invalid_grant");

    // 6. The minted token works against the MCP endpoint.
    const mcpRes = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tokenBody.access_token}`,
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "list_issues",
            arguments: { organizationId },
          },
        }),
      }),
      env
    );
    expect(mcpRes.status).toBe(200);
    const mcpBody = (await mcpRes.json()) as {
      result?: { isError?: boolean };
      error?: { message: string };
    };
    expect(mcpBody.error).toBeUndefined();
    expect(mcpBody.result?.isError).not.toBe(true);
  });

  it("redirects unauthenticated users to sign-in", async () => {
    const res = await app.fetch(
      new Request(
        "http://localhost/oauth/authorize?client_id=x&redirect_uri=http://localhost/cb"
      ),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/app/sign-in");
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { agentLogToken } from "../agents/credentials.js";
import { CursorCliAgentProvider } from "../agents/cursor-cli.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { AppEnv } from "../platform/env.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";

// PILE-277 — Pile-side half of the lane adversarial suite (the runner half
// is src/agents/runner/lane-security.node.test.ts). A lane holds its lane
// token and an installation token; these tests drive the HTTP surface that
// token can reach the way a hostile lane would.

const ORIGIN = "https://your-domain.com";
const REPO = "VortexNYC/pile";
const FAKE_INSTALLATION_TOKEN = "ghs_LaneSecurityFakeInstallationToken0001";

function request(
  path: string,
  init: RequestInit & { token?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method ?? "GET")) {
    headers.set("Origin", ORIGIN);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function generatePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(pkcs8 instanceof ArrayBuffer)) throw new Error("pkcs8 export failed");
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function tokenPath(orgId: string, sessionId: string): string {
  return `/workspaces/${orgId}/agent/sessions/${sessionId}/github-token`;
}

describe("lane security: Pile endpoints reachable with a lane token", () => {
  let organizationId: string;
  let adminToken: string;

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
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Lane security tests",
      slug: `lane-sec-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    organizationId = workspace!.id;
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "lane-sec-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    adminToken = z.object({ key: z.string() }).parse(result).key;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function laneSession(
    status: AgentSessionStatus = "running",
    repo: string | null = REPO
  ) {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Lane security fixture",
      ...(repo ? { repo } : {}),
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status,
      providerSessionId: `lane-sec-${crypto.randomUUID()}`,
    });
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      session.id
    );
    if (!laneToken) throw new Error("lane token derivation failed");
    return { stub, issue, session, laneToken };
  }

  describe("tokenExfil: installation-token mint", () => {
    it("refuses a lane token minted for a different session", async () => {
      const victim = await laneSession();
      const attacker = await laneSession();
      const res = await app.fetch(
        request(tokenPath(organizationId, victim.session.id), {
          method: "POST",
          token: attacker.laneToken,
        }),
        env
      );
      expect(res.status).toBe(401);
    });

    it("refuses a lane token replayed against another workspace", async () => {
      const { session, laneToken } = await laneSession();
      const res = await app.fetch(
        request(tokenPath(crypto.randomUUID(), session.id), {
          method: "POST",
          token: laneToken,
        }),
        env
      );
      expect(res.status).toBe(401);
    });

    it("refuses to mint once the session is terminal", async () => {
      for (const status of ["completed", "failed", "canceled"] as const) {
        const { session, laneToken } = await laneSession(status);
        const res = await app.fetch(
          request(tokenPath(organizationId, session.id), {
            method: "POST",
            token: laneToken,
          }),
          env
        );
        expect(res.status).toBe(409);
      }
    });

    it("refuses to mint for a session whose issue has no repository", async () => {
      const { session, laneToken } = await laneSession("running", null);
      const res = await app.fetch(
        request(tokenPath(organizationId, session.id), {
          method: "POST",
          token: laneToken,
        }),
        env
      );
      expect(res.status).toBe(422);
    });

    it("mints a token scoped to the session repo only, ignoring lane-supplied targets", async () => {
      const { session, laneToken } = await laneSession();
      const privateKey = await generatePrivateKeyPem();
      const minted: Array<{ url: string; body: unknown }> = [];
      const lookedUp: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/installation")) {
          lookedUp.push(url);
          return Response.json({ id: 4242 });
        }
        if (url.endsWith("/app/installations/4242/access_tokens")) {
          const raw = typeof init?.body === "string" ? init.body : null;
          minted.push({ url, body: raw ? JSON.parse(raw) : null });
          return Response.json({ token: FAKE_INSTALLATION_TOKEN });
        }
        return new Response("unexpected", { status: 599 });
      });

      const res = await app.fetch(
        request(
          `${tokenPath(organizationId, session.id)}?repo=VortexNYC/vortex-payments`,
          {
            method: "POST",
            token: laneToken,
            body: JSON.stringify({
              repo: "VortexNYC/vortex-payments",
              repositories: ["vortex-payments"],
              permissions: { administration: "write" },
            }),
          }
        ),
        {
          ...env,
          GITHUB_APP_ID: "123",
          GITHUB_PRIVATE_KEY: privateKey,
        }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        token: FAKE_INSTALLATION_TOKEN,
        expiresAt: null,
      });
      // fetchLanePermissions resolves the lane's push tier on every mint —
      // that auths its .pile/config.json fetch with a pile installation
      // lookup before the token mint's own lookup.
      expect(lookedUp).toEqual([
        "https://api.github.com/repos/VortexNYC/pile/installation",
        "https://api.github.com/repos/VortexNYC/pile/installation",
      ]);
      // The config-fetch mint carries no body (installation-wide, used only
      // to read .pile/config.json); the lane mint itself is repo-scoped and
      // permission-scoped. The 599 on the contents fetch resolves to the
      // locked tier, hence contents:read.
      expect(minted).toEqual([
        {
          url: "https://api.github.com/app/installations/4242/access_tokens",
          body: null,
        },
        {
          url: "https://api.github.com/app/installations/4242/access_tokens",
          body: {
            repositories: ["pile"],
            permissions: { contents: "read", metadata: "read" },
          },
        },
      ]);
    });
    it("mints for a configured secondary repo only (PILE-294)", async () => {
      const stub = env.WORKSPACE_DURABLE_OBJECT.get(
        env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
      );
      await stub.setOrganizationId(organizationId);
      const issue = await stub.createIssue({
        title: "Cross-repo lane fixture",
        repo: REPO,
      });
      const session = await stub.createAgentSession({
        issueId: issue.id,
        agentId: "mock",
        provider: "mock",
        actorId: "user-1",
        actorType: "user",
        status: "running",
        providerSessionId: `lane-sec-${crypto.randomUUID()}`,
        secondaryRepos: JSON.stringify([
          { repo: "VortexNYC/vortex", access: "read" },
        ]),
      });
      const laneToken = await agentLogToken(
        env as unknown as WorkerEnv,
        organizationId,
        session.id
      );
      if (!laneToken) throw new Error("lane token derivation failed");
      const privateKey = await generatePrivateKeyPem();
      const minted: unknown[] = [];
      const lookedUp: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/installation")) {
          lookedUp.push(url);
          return Response.json({ id: 4242 });
        }
        if (url.endsWith("/app/installations/4242/access_tokens")) {
          const raw = typeof init?.body === "string" ? init.body : null;
          minted.push(raw ? JSON.parse(raw) : null);
          return Response.json({ token: FAKE_INSTALLATION_TOKEN });
        }
        return new Response("unexpected", { status: 599 });
      });
      const appEnv = {
        ...env,
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY: privateKey,
      };
      for (const repo of ["vortexnyc/VORTEX", "VortexNYC/vortex-payments"]) {
        const res = await app.fetch(
          request(`${tokenPath(organizationId, session.id)}?repo=${repo}`, {
            method: "POST",
            token: laneToken,
          }),
          appEnv
        );
        expect(res.status).toBe(200);
      }
      expect(lookedUp).toEqual([
        "https://api.github.com/repos/VortexNYC/pile/installation",
        "https://api.github.com/repos/VortexNYC/vortex/installation",
        "https://api.github.com/repos/VortexNYC/pile/installation",
        "https://api.github.com/repos/VortexNYC/pile/installation",
      ]);
      expect(minted).toEqual([
        null,
        {
          repositories: ["vortex"],
          permissions: { contents: "read", metadata: "read" },
        },
        null,
        {
          repositories: ["pile"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      await stub.updateAgentSession(session.id, { status: "completed" });
    });
  });

  describe("tokenExfil: transcript and result persistence", () => {
    it("masks credentials a lane echoes into its log stream", async () => {
      const { session, laneToken } = await laneSession();
      const leaked = [
        `token=${FAKE_INSTALLATION_TOKEN}`,
        `remote: https://x-access-token:${FAKE_INSTALLATION_TOKEN}@github.com/${REPO}.git`,
        "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
        `Authorization: Bearer ${laneToken}`,
      ];
      const post = await app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${session.id}/logs`,
          {
            method: "POST",
            token: laneToken,
            body: JSON.stringify({ lines: leaked }),
          }
        ),
        env
      );
      expect(post.status).toBe(200);

      const events = await app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
          { token: adminToken }
        ),
        env
      );
      expect(events.status).toBe(200);
      const text = await events.text();
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(FAKE_INSTALLATION_TOKEN);
      expect(text).not.toContain("github_pat_11ABCDEFG");
      expect(text).not.toContain(laneToken);
    });

    it("masks credentials in a lane's reported result", async () => {
      const { session, laneToken } = await laneSession();
      const res = await app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${session.id}/report`,
          {
            method: "POST",
            token: laneToken,
            body: JSON.stringify({
              status: "completed",
              result: `done; env GITHUB_TOKEN=${FAKE_INSTALLATION_TOKEN}`,
            }),
          }
        ),
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ session: { result: string | null } }>();
      expect(body.session.result).toContain("[REDACTED]");
      expect(body.session.result).not.toContain(FAKE_INSTALLATION_TOKEN);
    });
  });

  describe("pushRestrictedAdversarial: PR URL redirection", () => {
    // The sweep mints installation tokens and calls update-branch for the
    // session's prUrl, so a lane must not be able to point it at a PR on a
    // repository it was not dispatched against.
    for (const prUrl of [
      "https://github.com/VortexNYC/vortex-payments/pull/1",
      "https://github.com/VortexNYC/pile-evil/pull/1",
      "https://github.com/evil/pile/pull/1",
      "https://github.com/VortexNYC/pile/pull/1/../../../../vortex-payments/pull/2",
      "https://github.com.evil.test/VortexNYC/pile/pull/1",
    ]) {
      it(`rejects a reported prUrl outside the session repo: ${prUrl}`, async () => {
        const { session, laneToken, stub } = await laneSession();
        for (const status of [undefined, "completed"]) {
          const res = await app.fetch(
            request(
              `/workspaces/${organizationId}/agent/sessions/${session.id}/report`,
              {
                method: "POST",
                token: laneToken,
                body: JSON.stringify({ prUrl, ...(status ? { status } : {}) }),
              }
            ),
            env
          );
          expect(res.status).toBe(400);
        }
        const after = await stub.getAgentSession(session.id);
        expect(after?.prUrl ?? null).toBeNull();
        expect(after?.status).toBe("running");
      });
    }

    it("accepts a prUrl on the session repo (case-insensitive owner)", async () => {
      const { session, laneToken } = await laneSession();
      const res = await app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${session.id}/report`,
          {
            method: "POST",
            token: laneToken,
            body: JSON.stringify({
              prUrl: "https://github.com/vortexnyc/pile/pull/77",
            }),
          }
        ),
        env
      );
      expect(res.status).toBe(200);
    });

    it("drops a provider-polled prUrl outside the session repo", async () => {
      const { session, stub } = await laneSession();
      const updated = await stub.applyAgentSessionResult(session.id, {
        status: "completed",
        result: `pushed with ${FAKE_INSTALLATION_TOKEN}`,
        prUrl: "https://github.com/VortexNYC/vortex-payments/pull/5",
        prState: "open",
      });
      expect(updated?.status).toBe("completed");
      expect(updated?.prUrl ?? null).toBeNull();
      expect(updated?.result).not.toContain(FAKE_INSTALLATION_TOKEN);
      const issue = await stub.getIssue(session.issueId);
      expect(issue?.prUrl ?? null).toBeNull();
    });
  });

  describe("fsExfil: pnpm-store cache keys", () => {
    for (const hash of [
      "..%2F..%2Fsecrets",
      "AB".repeat(32),
      "ab".repeat(31),
      `${"ab".repeat(32)}%2F..`,
    ]) {
      it(`rejects a non-content-hash cache key: ${hash}`, async () => {
        const { session, laneToken } = await laneSession();
        const res = await app.fetch(
          request(
            `/workspaces/${organizationId}/agent/sessions/${session.id}/cache/pnpm-store/${hash}`,
            { method: "GET", token: laneToken }
          ),
          env
        );
        // Rejected either by the auth middleware (lane-token bypass only
        // matches content-hash paths) or by the route's own hash check.
        expect([400, 401, 404]).toContain(res.status);
      });
    }

    it("refuses another session's lane token on the cache", async () => {
      const victim = await laneSession();
      const attacker = await laneSession();
      const res = await app.fetch(
        request(
          `/workspaces/${organizationId}/agent/sessions/${victim.session.id}/cache/pnpm-store/${"ab".repeat(32)}`,
          { method: "PUT", token: attacker.laneToken, body: "poison" }
        ),
        env
      );
      expect(res.status).toBe(401);
    });
  });
});

describe("gitFlagInjection: lane branch names at dispatch", () => {
  const gitIdentity = {
    repo: REPO,
    name: "Vortex Agent",
    email: "agent@example.com",
  } as unknown as GitIdentity;

  for (const branch of [
    "--upload-pack=touch /tmp/pwned",
    "-c",
    "issue-1:main",
    "+issue-1",
    "refs/heads/main",
    "HEAD",
    "issue-1..main",
    "issue 1",
    "issue-1\nmain",
    "issue-1~1",
    "issue-1^{}",
    "@{-1}",
    ".hidden",
    "issue-1.lock",
  ]) {
    it(`refuses to provision a lane on ${JSON.stringify(branch)}`, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const provider = new CursorCliAgentProvider({
        DAYTONA_API_KEY: "daytona-key",
        CURSOR_API_KEY: "cursor-key",
      } as AppEnv);
      const issue = {
        id: "issue-1",
        title: "t",
        repo: REPO,
        branch,
      } as unknown as Issue;
      await expect(
        provider.dispatch("org-1", issue, "auto", {
          sessionId: "sess-1",
          gitIdentity,
        })
      ).rejects.toThrow("safe lane branch");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  }
});

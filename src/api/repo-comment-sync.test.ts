import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createD1 } from "../global/db.js";
import { createGithubInstallation } from "../global/github-installations.js";
import { createRepoIssue } from "../global/repo-issues.js";
import { organization } from "../global/schema.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { syncCommentToRepoMapping } from "./repo-comment-sync.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const ORG_ID = "org-repo-sync";

async function ensureOrg() {
  const db = createD1(env.D1);
  await db
    .insert(organization)
    .values({
      id: ORG_ID,
      name: "Repo sync",
      slug: ORG_ID,
      metadata: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  return db;
}

function workspaceStub() {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(ORG_ID)
  );
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

describe("syncCommentToRepoMapping (PILE-428)", () => {
  it("returns null when the issue has no repo mapping", async () => {
    const db = await ensureOrg();
    const result = await syncCommentToRepoMapping(
      env,
      db,
      workspaceStub(),
      { id: "issue-no-mapping", organizationId: ORG_ID },
      { id: "comment-1", body: "held" }
    );
    expect(result).toBeNull();
  });

  it("returns null when the mapped repo has no GitHub installation", async () => {
    const db = await ensureOrg();
    await createRepoIssue(
      db,
      ORG_ID,
      "VortexNYC/no-install",
      9,
      "issue-no-inst"
    );
    const result = await syncCommentToRepoMapping(
      env,
      db,
      workspaceStub(),
      { id: "issue-no-inst", organizationId: ORG_ID },
      { id: "comment-2", body: "held" }
    );
    expect(result).toBeNull();
  });

  it("posts the comment to GitHub and stamps the external id", async () => {
    const db = await ensureOrg();
    const privateKey = await generatePrivateKeyPem();
    await createRepoIssue(db, ORG_ID, "VortexNYC/synced", 7, "issue-synced");
    await createGithubInstallation(db, ORG_ID, "4242", "VortexNYC/synced");

    const stub = workspaceStub();
    await stub.setOrganizationId(ORG_ID);
    const comment = await stub.createComment({
      issueId: "issue-synced",
      body: "held draft body",
    });
    expect(comment?.id).toBeTruthy();

    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requests.push(url);
      if (url.endsWith("/app/installations/4242/access_tokens")) {
        return Response.json({ token: "ghs_test_token" });
      }
      if (url.endsWith("/repos/VortexNYC/synced/issues/7/comments")) {
        return Response.json({ id: 4242 });
      }
      return new Response("unexpected", { status: 599 });
    });
    try {
      const synced = await syncCommentToRepoMapping(
        { ...env, GITHUB_APP_ID: "123", GITHUB_PRIVATE_KEY: privateKey },
        db,
        stub,
        { id: "issue-synced", organizationId: ORG_ID },
        { id: comment!.id, body: "held draft body" }
      );
      expect(synced?.externalId).toBe("4242");
      expect(synced?.externalSource).toBe("github");
      expect(requests).toEqual([
        "https://api.github.com/app/installations/4242/access_tokens",
        "https://api.github.com/repos/VortexNYC/synced/issues/7/comments",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

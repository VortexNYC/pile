import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { encryptSecret } from "./credentials.js";
import {
  reapLaneGithubTokens,
  revokeLaneGithubToken,
} from "./lane-github-token.js";

function revokeSpy() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    );
}

function revokedTokens(spy: ReturnType<typeof revokeSpy>): string[] {
  return spy.mock.calls
    .filter(
      ([input, init]) =>
        String(input) === "https://api.github.com/installation/token" &&
        init?.method === "DELETE"
    )
    .map(([, init]) => new Headers(init?.headers).get("authorization") ?? "");
}

describe("lane GitHub tokens", () => {
  const userId = "user-lane-gh";
  let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Lane GH",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Lane GH",
      slug: `lane-gh-${crypto.randomUUID()}`,
      key: `LG${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    const organizationId = workspace!.id;
    stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function session(status: "running" | "completed") {
    const issue = await stub.createIssue({ title: `lane token ${status}` });
    return stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: userId,
      actorType: "user",
      status,
    });
  }

  it("stores tokens encrypted and hands back the previous one on swap", async () => {
    const s = await session("running");
    const first = await encryptSecret(env, "ghs_firsttoken0000000000");
    expect(first).not.toContain("ghs_");
    expect(await stub.swapLaneGithubToken(s.id, first)).toBeNull();
    const second = await encryptSecret(env, "ghs_secondtoken000000000");
    expect(await stub.swapLaneGithubToken(s.id, second)).toBe(first);
    expect(await stub.listLaneGithubTokenSessions()).toContain(s.id);
  });

  it("revokes a terminal session's token and forgets it", async () => {
    const s = await session("completed");
    await stub.swapLaneGithubToken(
      s.id,
      await encryptSecret(env, "ghs_terminaltoken0000000")
    );
    const spy = revokeSpy();

    await reapLaneGithubTokens(env, stub);

    expect(revokedTokens(spy)).toContain("Bearer ghs_terminaltoken0000000");
    expect(await stub.listLaneGithubTokenSessions()).not.toContain(s.id);
    expect(await revokeLaneGithubToken(env, stub, s.id)).toBe(false);
  });

  it("leaves a live session's token alone", async () => {
    const s = await session("running");
    await stub.swapLaneGithubToken(
      s.id,
      await encryptSecret(env, "ghs_livetoken00000000000")
    );
    const spy = revokeSpy();

    await reapLaneGithubTokens(env, stub);

    expect(revokedTokens(spy)).not.toContain("Bearer ghs_livetoken00000000000");
    expect(await stub.listLaneGithubTokenSessions()).toContain(s.id);
  });

  it("revokes tokens whose session no longer exists", async () => {
    await stub.swapLaneGithubToken(
      "missing-session",
      await encryptSecret(env, "ghs_orphantoken000000000")
    );
    const spy = revokeSpy();

    await reapLaneGithubTokens(env, stub);

    expect(revokedTokens(spy)).toContain("Bearer ghs_orphantoken000000000");
    expect(await stub.listLaneGithubTokenSessions()).not.toContain(
      "missing-session"
    );
  });
});

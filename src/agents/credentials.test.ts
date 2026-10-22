import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { WorkspaceDO } from "../workspace/durable-object.js";
import {
  agentLogToken,
  decryptProviderConfigRow,
  decryptSecret,
  encryptProviderConfigInput,
  encryptSecret,
  expectedSessionToken,
  isEncrypted,
  verifySessionToken,
} from "./credentials.js";
import { MockAgentProvider } from "./harness.js";
import { dispatchAgent, registerAgentProvider } from "./index.js";

const wenv = env as unknown as WorkerEnv;

const actor = {
  id: "user-1",
  organizationId: "org_credentials_test",
  type: "user" as const,
  permissions: [],
};

let defaultTeamId: string | undefined;

describe("agent credentials at rest", () => {
  it("encrypts and decrypts a secret round-trip", async () => {
    const encrypted = await encryptSecret(wenv, "super-secret-token");
    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain("super-secret-token");
    expect(await decryptSecret(wenv, encrypted)).toBe("super-secret-token");
  });

  it("passes legacy plaintext through decryptSecret", async () => {
    expect(await decryptSecret(wenv, "plaintext-token")).toBe(
      "plaintext-token"
    );
    expect(await decryptSecret(wenv, null)).toBeNull();
  });

  it("encrypts provider config fields and decrypts the stored row", async () => {
    const input = await encryptProviderConfigInput(wenv, {
      token: "provider-key",
      computeApiKey: "compute-key",
      config: { model: "cursor-grok-4.6-medium", webhookSecret: "whsec" },
    });
    expect(isEncrypted(input.token)).toBe(true);
    expect(isEncrypted(input.computeApiKey)).toBe(true);
    expect(JSON.stringify(input.config)).not.toContain("whsec");
    expect(JSON.stringify(input.config)).not.toContain(
      "cursor-grok-4.6-medium"
    );

    const row = {
      agentId: "cursor-cli",
      token: input.token ?? null,
      providerOrgId: null,
      computeApiKey: input.computeApiKey ?? null,
      computeApiUrl: null,
      computeSnapshot: null,
      computeVolumeId: null,
      config: JSON.stringify(input.config),
      teamIds: null,
      createdAt: "",
      updatedAt: "",
    };
    const decrypted = await decryptProviderConfigRow(wenv, row);
    expect(decrypted?.token).toBe("provider-key");
    expect(decrypted?.computeApiKey).toBe("compute-key");
    const config = JSON.parse(decrypted?.config ?? "{}") as Record<
      string,
      unknown
    >;
    expect(config.model).toBe("cursor-grok-4.6-medium");
    expect(config.webhookSecret).toBe("whsec");
  });
});

describe("BYOK dispatch wiring", () => {
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
      name: "Credentials test workspace",
      slug: "credentials-test-ws",
      ownerId: actor.id,
    });
    if (workspace) {
      actor.organizationId = workspace.id;
      const team = await createDefaultTeam(
        db,
        env,
        headers,
        workspace.id,
        "CRT",
        actor.id
      );
      defaultTeamId = team.id;
    }
  });

  it("dispatches with the workspace's stored provider credentials", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    ) as DurableObjectStub<WorkspaceDO>;
    await stub.setOrganizationId(actor.organizationId);
    const encrypted = await encryptProviderConfigInput(wenv, {
      token: "workspace-owned-token",
      config: { model: "cursor-grok-4.6-medium" },
    });
    await stub.upsertAgentProviderConfig({
      agentId: "mock-byok",
      ...encrypted,
    });

    let capturedEnv: WorkerEnv | undefined;
    registerAgentProvider("mock-byok", (e) => {
      capturedEnv = e;
      return new MockAgentProvider("mock-byok");
    });

    const issue = await stub.createIssue({
      title: "BYOK dispatch test",
      teamId: defaultTeamId,
    });
    await dispatchAgent(wenv, "mock-byok", actor.organizationId, issue, actor);

    expect(capturedEnv?.AGENT_PROVIDER_TOKEN).toBe("workspace-owned-token");
    expect(capturedEnv?.CURSOR_API_KEY).toBe("workspace-owned-token");
    expect(capturedEnv?.CURSOR_CLI_MODEL).toBe("cursor-grok-4.6-medium");
  });
});

describe("lane session tokens (PILE-457)", () => {
  const laneOrg = "org_lane_token_test";

  async function laneSession(status: "running" | "failed" = "running") {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(laneOrg)
    ) as DurableObjectStub<WorkspaceDO>;
    await stub.setOrganizationId(laneOrg);
    return stub.createAgentSession({
      issueId: crypto.randomUUID(),
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status,
    });
  }

  it("mints a verifiable bearer for a live session only", async () => {
    const live = await laneSession("running");
    const token = await agentLogToken(wenv, laneOrg, live.id);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await verifySessionToken(wenv, `Bearer ${token}`, laneOrg, live.id)
    ).toBe(true);
    expect(
      await verifySessionToken(
        wenv,
        `Bearer ${token}`,
        laneOrg,
        crypto.randomUUID()
      )
    ).toBe(false);

    // Terminal and unknown sessions get no usable token.
    const dead = await laneSession("failed");
    expect(await agentLogToken(wenv, laneOrg, dead.id)).toBeNull();
    expect(await agentLogToken(wenv, laneOrg, crypto.randomUUID())).toBeNull();
  });

  it("rejects non-hex bearers without minting or verifying", async () => {
    const live = await laneSession("running");
    for (const header of [
      "Bearer not-a-token",
      "Bearer " + "0".repeat(63),
      "Bearer " + "0".repeat(65),
      "Basic " + "0".repeat(64),
    ]) {
      expect(await verifySessionToken(wenv, header, laneOrg, live.id)).toBe(
        false
      );
    }
  });

  it("first mint rotates a seedless legacy session onto the seeded derivation", async () => {
    const session = await laneSession("running");
    // No seed row yet: the verify path derives the legacy seedless bearer.
    const legacy = await expectedSessionToken(wenv, laneOrg, session.id);
    expect(legacy).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await verifySessionToken(wenv, `Bearer ${legacy}`, laneOrg, session.id)
    ).toBe(true);

    // Minting creates the seed — the legacy bearer dies with it.
    const seeded = await agentLogToken(wenv, laneOrg, session.id);
    expect(seeded).toMatch(/^[a-f0-9]{64}$/);
    expect(seeded).not.toBe(legacy);
    expect(
      await verifySessionToken(wenv, `Bearer ${legacy}`, laneOrg, session.id)
    ).toBe(false);
    expect(
      await verifySessionToken(wenv, `Bearer ${seeded}`, laneOrg, session.id)
    ).toBe(true);
  });
});

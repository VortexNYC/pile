import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import { member, organization, user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { drainDomainEvents } from "./pipeline-events.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const ORG = "test-pipeline-events";
const CHIEF_ENDPOINT = "https://chief.example.test/hook";
let teamId = "";

function stub() {
  return getWorkspaceStub(env, ORG);
}

async function gatedSubStep(title: string) {
  const parent = await stub().createIssue(
    { title: `${title} parent`, teamId },
    "test"
  );
  const child = await stub().createIssue(
    {
      title,
      teamId,
      parentId: parent.id,
      stepKey: `step_${crypto.randomUUID().slice(0, 6)}`,
      required: true,
    },
    "test"
  );
  return { parent, child };
}

async function deadLane(issueId: string, status: "failed" | "canceled") {
  const session = await stub().createAgentSession({
    issueId,
    agentId: "mock-scout",
    provider: "mock-scout",
    actorId: "test",
    actorType: "agent",
    status: "running",
  });
  await stub().applyAgentSessionResult(session.id, {
    status,
    result: "lane exploded",
  });
  return session;
}

describe("pipeline event drain — dead gated lanes (PILE-443)", () => {
  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-pipeline-events",
        name: "Pipeline Events",
        email: "pipeline-events@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db.insert(organization).values({
      id: ORG,
      name: "Pipeline events test",
      slug: "test-pipeline-events",
      metadata: JSON.stringify({ key: "PEVT" }),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: ORG,
      userId: "user-pipeline-events",
      role: "owner",
      createdAt: now,
    });
    const headers = await createAdminHeaders(env, "user-pipeline-events");
    const team = await createDefaultTeam(
      db,
      env,
      headers,
      ORG,
      "PEVT",
      "user-pipeline-events"
    );
    teamId = team.id;
    await stub().setOrganizationId(ORG);
    await stub().upsertAgentType({
      slug: "chief_of_staff",
      name: "Chief of Staff",
      providerAgentId: "flue",
      kind: "external",
      endpointUrl: CHIEF_ENDPOINT,
    });
  });

  it("POSTs agent.session_canceled to the chief when a gated lane is canceled", async () => {
    const { child } = await gatedSubStep("Canceled gated step");
    await deadLane(child.id, "canceled");

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await drainDomainEvents(env, stub(), ORG);
    } finally {
      vi.unstubAllGlobals();
    }

    // No reviewer or stage owner is registered — resolution falls
    // through to the chief, exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(CHIEF_ENDPOINT);
    const payload = JSON.parse(init.body as string) as {
      event: string;
      issueId: string;
      session: { status: string } | null;
    };
    expect(payload.event).toBe("agent.session_canceled");
    expect(payload.issueId).toBe(child.id);
    expect(payload.session?.status).toBe("canceled");
  });

  it("re-marks the domain event failed when a waitUntil external POST rejects", async () => {
    const { child } = await gatedSubStep("Flaky endpoint step");
    await deadLane(child.id, "failed");

    // Awaited drains throw and mark the event failed inline; the
    // waitUntil path resolves the handler first, so the dispatch task
    // itself must flip the event back once the POST settles.
    const fetchMock = vi.fn().mockRejectedValue(new Error("endpoint down"));
    vi.stubGlobal("fetch", fetchMock);
    const tasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    };
    try {
      await drainDomainEvents(env, stub(), ORG, ctx);
      await Promise.all(tasks);
    } finally {
      vi.unstubAllGlobals();
    }

    const rows = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT status, error FROM domain_events WHERE type = 'substep.review' AND json_extract(payload, '$.issueId') = ?",
          child.id
        )
        .toArray()
    );
    expect(rows).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("endpoint down"),
      }),
    ]);
  });
});

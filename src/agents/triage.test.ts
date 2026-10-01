import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { getDefaultTeam, updateTeam } from "../global/teams.js";
import { createLabel } from "../global/workspace-entities.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  buildTriageInstructions,
  dispatchTriageLane,
  parseTriageReport,
  planTriageApplication,
  TRIAGE_PURPOSE,
} from "./triage.js";

describe("parseTriageReport", () => {
  const report = {
    answer: null,
    labels: ["bug"],
    duplicates: ["ABC-1"],
    similar: [],
    plan: "1. fix it",
  };

  it("reads the last fenced json block", () => {
    const text = `Thinking...\n\`\`\`json\n{"labels": 1}\n\`\`\`\nFinal:\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
    expect(parseTriageReport(text)).toEqual(report);
  });

  it("reads a bare report object", () => {
    expect(parseTriageReport(JSON.stringify(report))?.plan).toBe("1. fix it");
  });

  it("reads a report nested in a runner JSON envelope", () => {
    const envelope = JSON.stringify({
      summary: `Done.\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
      digest: { files: 0 },
    });
    expect(parseTriageReport(envelope)?.duplicates).toEqual(["ABC-1"]);
  });

  it("returns null for prose or malformed output", () => {
    expect(parseTriageReport("No idea.")).toBeNull();
    expect(parseTriageReport("```json\n{not json}\n```")).toBeNull();
    expect(parseTriageReport(null)).toBeNull();
  });
});

describe("planTriageApplication", () => {
  it("keeps only known labels, de-dupes links and never links to self", () => {
    const plan = planTriageApplication(
      {
        labels: ["BUG", "invented", "ui"],
        duplicates: ["abc-2", "ABC-1", "ABC-2"],
        similar: ["ABC-2", "ABC-3"],
      },
      { identifier: "ABC-1", labelIds: "l-ui" },
      [
        { id: "l-bug", name: "bug" },
        { id: "l-ui", name: "UI" },
      ]
    );
    expect(plan.labelIds).toEqual(["l-ui", "l-bug"]);
    expect(plan.addedLabelNames).toEqual(["bug"]);
    expect(plan.duplicates).toEqual(["abc-2"]);
    expect(plan.similar).toEqual(["ABC-3"]);
  });
});

describe("buildTriageInstructions", () => {
  it("lists candidates and labels and asks for the json report", () => {
    const text = buildTriageInstructions(
      { identifier: "ABC-9", title: "Login fails", description: null },
      [{ identifier: "ABC-3", title: "Login broken", status: "todo" }],
      ["bug"]
    );
    expect(text).toContain("- ABC-3 [todo] Login broken");
    expect(text).toContain("- bug");
    expect(text).toContain("```json");
  });
});

describe("triage lane", () => {
  let organizationId: string;
  let teamId: string;
  const instructionsSeen: string[] = [];

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-triage",
        name: "Triage User",
        email: "user-triage@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-triage");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Triage workspace",
      slug: `triage-${crypto.randomUUID()}`,
      ownerId: "user-triage",
    });
    organizationId = workspace!.id;
    const team = await getDefaultTeam(db, organizationId);
    teamId = team!.id;
    await createLabel(db, organizationId, { name: "bug" });
    registerAgentProvider(
      "mock-triage",
      () =>
        new MockAgentProvider("mock-triage", {
          dispatch: (_org, issue, _model, ctx) => {
            instructionsSeen.push(ctx?.instructions ?? "");
            return {
              id: `triage-${issue.id}`,
              agentId: "mock-triage",
              issueId: issue.id,
              status: "running",
            };
          },
        })
    );
    const stub = getStub();
    await stub.setOrganizationId(organizationId);
    // Seed the candidate before enabling triage so only the new issue is
    // dispatched.
    await stub.createIssue({
      title: "Login page crashes on Safari",
      description: "Safari login crash after submitting credentials",
      teamId,
    });
    await updateTeam(db, env, headers, teamId, organizationId, {
      triageAgentId: "mock-triage",
    });
  });

  function getStub() {
    return env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
  }

  async function waitForTriageSession(issueId: string) {
    const stub = getStub();
    return vi.waitFor(async () => {
      const sessions = await stub.listAgentSessions({ issueId });
      const session = sessions.find((s) => s.purpose === TRIAGE_PURPOSE);
      expect(session).toBeDefined();
      return session!;
    });
  }

  it("skips drafts", async () => {
    const stub = getStub();
    const issue = await stub.createIssue({ title: "Untriaged", isDraft: true });
    await expect(
      dispatchTriageLane(env, organizationId, issue)
    ).resolves.toBeNull();
  });

  it("runs on issue creation and applies links, labels and a comment", async () => {
    const stub = getStub();
    const issue = await stub.createIssue({
      title: "Safari login crashes",
      description: "Login crashes on Safari when submitting credentials",
      status: "triage",
      teamId,
    });

    const session = await waitForTriageSession(issue.id);
    const prompt = instructionsSeen.at(-1) ?? "";
    expect(prompt).toContain("Login page crashes on Safari");

    // Triage lanes neither move the issue nor block a real lane.
    expect((await stub.getIssue(issue.id))?.status).toBe("triage");
    expect(await stub.getActiveAgentSessionForIssue(issue.id)).toBeNull();

    const similar = await stub.findSimilarIssues(issue.id, [teamId]);
    const candidate = similar[0]?.issue;
    expect(candidate?.title).toBe("Login page crashes on Safari");

    const report = {
      answer: "Known Safari issue.",
      labels: ["Bug", "nope"],
      duplicates: [candidate?.identifier],
      similar: [],
      plan: "1. Reproduce on Safari",
    };
    await stub.applyAgentSessionResult(session.id, {
      status: "completed",
      result: `Done\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
    });

    const updated = await stub.getIssue(issue.id);
    expect(updated?.labelIds?.split(",")).toHaveLength(1);
    const relations = await stub.listIssueRelations(issue.id);
    expect(relations).toEqual([
      expect.objectContaining({ toIssueId: candidate?.id, type: "duplicate" }),
    ]);
    const comments = await stub.listComments(issue.id);
    const body = comments.at(-1)?.body ?? "";
    expect(body).toContain("Known Safari issue.");
    expect(body).toContain("**Labels applied:** bug");
    expect(body).toContain(`**Possible duplicates:** ${candidate?.identifier}`);
    expect(body).toContain("1. Reproduce on Safari");
  });

  it("falls back to the raw result when the report is unparseable", async () => {
    const stub = getStub();
    const issue = await stub.createIssue({ title: "Odd ticket", teamId });
    const session = await waitForTriageSession(issue.id);
    await stub.applyAgentSessionResult(session.id, {
      status: "completed",
      result: "I could not triage this.",
    });
    const comments = await stub.listComments(issue.id);
    expect(comments.at(-1)?.body).toBe(
      "Triage by mock-triage:\n\nI could not triage this."
    );
    expect(await stub.listIssueRelations(issue.id)).toEqual([]);
  });
});

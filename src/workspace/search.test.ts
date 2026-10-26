import { describe, expect, it } from "vitest";

import type { Issue } from "../types/workspace.js";
import {
  commentToSearchDocument,
  createWorkspaceSearchIndex,
  documentToSearchDocument,
  findDuplicateCandidates,
  getSearchIndexMetrics,
  insert,
  insertMultiple,
  issueToSearchDocument,
  memoryToSearchDocument,
  remove,
  removeIssueDocuments,
  removeMemorySearchDocument,
  searchDocuments,
  searchIssues,
  searchMemories,
  searchSchema,
  titleOverlapScore,
  type MemoryForSearch,
  type SearchDocument,
} from "./search.js";

function issue(id: string, title: string, overrides: Partial<Issue> = {}) {
  return {
    id,
    organizationId: "org",
    externalRef: null,
    teamId: "team-a",
    title,
    description: null,
    status: "backlog",
    priority: "medium",
    resolution: null,
    resolutionReason: null,
    parentId: null,
    subIssueSortOrder: null,
    estimate: null,
    isDraft: false,
    sensitive: false,
    stepKey: null,
    required: false,
    ownerAgent: null,
    snoozedUntil: null,
    assigneeId: null,
    delegateId: null,
    claimedBy: null,
    claimedLeaseExpiresAt: null,
    claimEpoch: 0,
    projectId: null,
    cycleId: null,
    labelIds: null,
    number: 1,
    identifier: `T-${id}`,
    repo: null,
    branch: null,
    prUrl: null,
    prState: null,
    prCheckState: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies Issue;
}

function memory(
  id: string,
  fact: string,
  overrides: Partial<MemoryForSearch> = {}
): MemoryForSearch {
  return {
    id,
    entityType: "agent",
    entityId: "agent-1",
    kind: "lesson",
    fact,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("searchSchema", () => {
  it("keeps the published document shape stable for compatibility", () => {
    expect(Object.keys(searchSchema)).toEqual([
      "id",
      "kind",
      "issueId",
      "teamId",
      "identifier",
      "title",
      "description",
      "body",
      "status",
      "documentId",
      "memoryId",
    ]);
  });
});

describe("titleOverlapScore", () => {
  it("is 1 for identical significant terms and ignores case/punctuation", () => {
    expect(
      titleOverlapScore(
        "Webhook retries: flood queue",
        "webhook RETRIES flood queue!"
      )
    ).toBe(1);
  });

  it("scores shared terms over the larger term set", () => {
    expect(
      titleOverlapScore(
        "Webhook retries flood the delivery queue",
        "Webhook delivery retries need backoff"
      )
    ).toBeCloseTo(0.6);
  });

  it("is 0 when either title has no significant terms", () => {
    expect(titleOverlapScore("Fix it", "Fix it")).toBe(0);
  });
});

describe("searchIssues", () => {
  it("ranks identifier hits first and scopes to the caller's teams", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(
      index,
      issueToSearchDocument(
        issue("abc-1", "Unrelated title", {
          identifier: "VTX-42",
          description: "nothing about webhooks",
        })
      )
    );
    await insert(
      index,
      issueToSearchDocument(
        issue("abc-2", "Webhook retries", {
          identifier: "VTX-77",
        })
      )
    );
    await insert(
      index,
      issueToSearchDocument(
        issue("abc-3", "Webhook retries exact clone", {
          identifier: "VTX-42X",
          teamId: "team-b",
        })
      )
    );

    // Exact identifier match beats content matches.
    const exact = await searchIssues(index, "vtx-42", ["team-a"]);
    expect(exact[0]).toBe("abc-1");

    // Substring identifier match works for partial keys.
    const partial = await searchIssues(index, "tx-4", ["team-a"]);
    expect(partial).toContain("abc-1");
    expect(partial).not.toContain("abc-3");
  });

  it("surfaces issues through comment bodies and tolerates one typo", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(index, issueToSearchDocument(issue("i-1", "Deploy pipeline")));
    await insert(
      index,
      commentToSearchDocument({
        id: "c-1",
        issueId: "i-1",
        teamId: "team-a",
        body: "The canary deployment saturated the pgbouncer pool",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    );

    const hits = await searchIssues(index, "pgbouncer", ["team-a"]);
    expect(hits).toEqual(["i-1"]);

    // One-character-off query still lands via tolerance.
    const fuzzy = await searchIssues(index, "pgbouncrr", ["team-a"]);
    expect(fuzzy).toEqual(["i-1"]);
  });

  it("never returns document or unattached memory ids when teamIds is empty", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(index, issueToSearchDocument(issue("i-z", "zebroid host")));
    await insert(
      index,
      documentToSearchDocument({
        id: "doc-z",
        title: "zebroid field guide",
        content: "all about zebroid",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    );
    await insert(
      index,
      memoryToSearchDocument(memory("mem-z", "zebroid unattached fact"))
    );

    // Empty teamIds means "no team filter" — documents and unattached
    // memories still must not leak into an *issue* result set.
    expect(await searchIssues(index, "zebroid", [])).toEqual(["i-z"]);
  });
});

describe("searchDocuments", () => {
  it("indexes markdown documents and survives 200KB single-token payloads without stack overflow (VTX-649)", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(
      index,
      issueToSearchDocument(
        issue("huge-token", "Canary 200KB", {
          description: `prefix ${"A".repeat(200_000)} suffix`,
        })
      )
    );
    await insert(
      index,
      documentToSearchDocument({
        id: "doc-md-1",
        title: "Handoff Note",
        content:
          "# Handoff\n\nExponential backoff landed on rateLimitHoldUntil.",
        createdAt: "2026-10-22T00:00:00.000Z",
      })
    );
    const docIds = await searchDocuments(index, "rateLimitHoldUntil");
    expect(docIds).toEqual(["doc-md-1"]);
  });
});

describe("workspace_memory indexing (PILE-618/629)", () => {
  it("indexes memory facts and finds them with multi-term BM25", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(
      index,
      memoryToSearchDocument(
        memory(
          "mem-1",
          "corridor:smith-st swept yesterday — 42 active licenses found"
        )
      )
    );
    await insert(
      index,
      memoryToSearchDocument(
        memory("mem-2", "billing webhook retries need idempotency keys")
      )
    );

    const hits = await searchMemories(index, "smith corridor licenses");
    expect(hits).toContain("mem-1");
    expect(hits).not.toContain("mem-2");

    // entityId/kind ride in the title field so they are searchable too.
    const byKind = await searchMemories(index, "lesson");
    expect(byKind).toEqual(["mem-1", "mem-2"]);
  });

  it("contributes issue-attached memories to searchIssues", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(index, issueToSearchDocument(issue("i-9", "Payment page")));
    await insert(
      index,
      memoryToSearchDocument(
        memory("mem-9", "zebroid token rotation broke checkout", {
          entityType: "issue",
          entityId: "T-i-9",
          issueId: "i-9",
          teamId: "team-a",
        })
      )
    );

    const hits = await searchIssues(index, "zebroid", ["team-a"]);
    expect(hits).toEqual(["i-9"]);
  });

  it("removes memory documents and superseded heads stay out", async () => {
    const index = createWorkspaceSearchIndex();
    await insert(
      index,
      memoryToSearchDocument(memory("mem-old", "stale quagga fact"))
    );
    await removeMemorySearchDocument(index, "mem-old");
    expect(await searchMemories(index, "quagga")).toEqual([]);

    // Re-insert then remove via removeIssueDocuments on an attached memory.
    await insert(
      index,
      memoryToSearchDocument(
        memory("mem-att", "attached quagga note", {
          issueId: "i-x",
          teamId: "team-a",
        })
      )
    );
    await insert(index, issueToSearchDocument(issue("i-x", "Host issue")));
    await removeIssueDocuments(index, "i-x");
    expect(await searchIssues(index, "quagga", ["team-a"])).toEqual([]);
    expect(await searchIssues(index, "Host issue", ["team-a"])).toEqual([]);
  });
});

describe("index maintenance", () => {
  it("replaces documents on re-insert and reports metrics", async () => {
    const index = createWorkspaceSearchIndex();
    const doc: SearchDocument = issueToSearchDocument(
      issue("i-1", "Wombat release checklist")
    );
    await insert(index, doc);
    await insert(
      index,
      issueToSearchDocument(issue("i-1", "Quokka release checklist"))
    );

    expect(await searchIssues(index, "wombat", ["team-a"])).toEqual([]);
    expect(await searchIssues(index, "quokka", ["team-a"])).toEqual(["i-1"]);

    const metrics = getSearchIndexMetrics(index);
    expect(metrics.activeDocs).toBe(1);
    // The replaced entry stays as a tombstone slot.
    expect(metrics.totalSlots).toBe(2);
    expect(metrics.vocabSize).toBeGreaterThan(0);

    await remove(index, "i-1");
    expect(await searchIssues(index, "quokka", ["team-a"])).toEqual([]);
    expect(getSearchIndexMetrics(index).activeDocs).toBe(0);
  });
});

describe("findDuplicateCandidates", () => {
  it("returns open, in-scope, close title matches best first", async () => {
    const index = createWorkspaceSearchIndex();
    await Promise.all(
      [
        issue("exact", "Webhook retries flood the delivery queue"),
        issue("close", "Webhook retries flooding the delivery queue"),
        issue("weak", "Webhook signing secret rotation"),
        issue("done", "Webhook retries flood the delivery queue", {
          status: "done",
        }),
        issue("other-team", "Webhook retries flood the delivery queue", {
          teamId: "team-b",
        }),
      ].map((row) => insert(index, issueToSearchDocument(row)))
    );

    const hits = await findDuplicateCandidates(
      index,
      "Webhook retries flood the delivery queue",
      ["team-a"]
    );
    expect(hits.map((hit) => hit.issueId)).toEqual(["exact", "close"]);
    expect(hits[0].score).toBe(1);
  });
});

// PILE-612 — the failure mode this replaces: Orama retained every doc's
// full text and per-token object maps, which blew the 128 MB DO isolate on
// mature workspaces. This index must hold the same corpus in bounded memory
// while answering the same queries.
describe("large-workspace scale (PILE-612)", () => {
  const WORDS = [
    "webhook",
    "retries",
    "delivery",
    "queue",
    "backoff",
    "billing",
    "checkout",
    "sandbox",
    "dispatch",
    "memory",
    "search",
    "index",
    "deploy",
    "receipts",
    "tokens",
    "rotation",
    "signal",
    "corridor",
    "merchant",
    "license",
    "cursor",
    "linear",
    "slack",
    "notion",
  ];
  const words = (seed: number, count: number) => {
    const out: string[] = [];
    let s = seed;
    for (let i = 0; i < count; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      out.push(WORDS[s % WORDS.length]);
    }
    return out.join(" ");
  };

  it("indexes 1500 issues + 2500 comments + 200 documents + 300 memories and answers queries", async () => {
    const index = createWorkspaceSearchIndex();
    const start = Date.now();

    const docs: SearchDocument[] = [];
    for (let i = 0; i < 1500; i++) {
      docs.push(
        issueToSearchDocument(
          issue(`iss-${i}`, `${words(i * 7 + 1, 6)} item ${i}`, {
            identifier: `VTX-${i}`,
            description: `context ${words(i * 13 + 3, 30)}`,
            teamId: i % 10 === 0 ? "team-b" : "team-a",
          })
        )
      );
    }
    for (let i = 0; i < 2500; i++) {
      docs.push(
        commentToSearchDocument({
          id: `cmt-${i}`,
          issueId: `iss-${i % 1500}`,
          teamId: (i % 1500) % 10 === 0 ? "team-b" : "team-a",
          body: `note ${words(i * 17 + 5, 20)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        })
      );
    }
    for (let i = 0; i < 200; i++) {
      docs.push(
        documentToSearchDocument({
          id: `doc-${i}`,
          title: `doc ${i} ${words(i * 19 + 7, 4)}`,
          content: `# Doc\n\n${words(i * 23 + 11, 60)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        })
      );
    }
    for (let i = 0; i < 300; i++) {
      docs.push(
        memoryToSearchDocument(
          memory(`mem-${i}`, `fact ${words(i * 29 + 13, 15)}`, {
            issueId: i % 3 === 0 ? `iss-${i}` : undefined,
            teamId: i % 3 === 0 ? "team-a" : undefined,
          })
        )
      );
    }
    // A needle every layer can find.
    docs.push(
      issueToSearchDocument(
        issue("iss-needle", "zebroid quixotic needle", {
          identifier: "VTX-NEEDLE",
        })
      ),
      commentToSearchDocument({
        id: "cmt-needle",
        issueId: "iss-needle",
        teamId: "team-a",
        body: "extra zebroid context",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      memoryToSearchDocument(
        memory("mem-needle", "zebroid quixotic fact", {
          issueId: "iss-needle",
          teamId: "team-a",
        })
      )
    );
    await insertMultiple(index, docs);

    const elapsed = Date.now() - start;
    const metrics = getSearchIndexMetrics(index);
    expect(metrics.activeDocs).toBe(1500 + 2500 + 200 + 300 + 3);
    expect(metrics.vocabSize).toBeGreaterThan(0);
    // Generous bound — the Orama build took tens of seconds before OOMing;
    // this should be comfortably under 60s even on a slow lane.
    expect(elapsed).toBeLessThan(60_000);

    const issueHits = await searchIssues(index, "zebroid", ["team-a"]);
    expect(issueHits).toEqual(["iss-needle"]);

    const identHits = await searchIssues(index, "vtx-needle", ["team-a"]);
    expect(identHits[0]).toBe("iss-needle");

    const memHits = await searchMemories(index, "zebroid quixotic");
    expect(memHits).toEqual(["mem-needle"]);

    const dups = await findDuplicateCandidates(
      index,
      "zebroid quixotic needle",
      ["team-a"]
    );
    expect(dups[0]?.issueId).toBe("iss-needle");
    expect(dups[0]?.score).toBe(1);
  });
});

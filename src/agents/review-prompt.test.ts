import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import { CodexAgentProvider } from "./codex.js";
import { CursorAgentProvider } from "./cursor.js";
import { DevinAgentProvider } from "./devin.js";
import { DOMAIN_REVIEW_PROMPT } from "./review-prompt.js";

const issue: Issue = {
  id: "issue-1",
  organizationId: "org-1",
  externalRef: null,
  teamId: "team-1",
  title: "Fix refunds",
  description: "Ensure concurrent refunds cannot exceed the paid amount.",
  status: "todo",
  priority: "medium",
  resolution: null,
  parentId: null,
  subIssueSortOrder: null,
  estimate: null,
  isDraft: false,
  snoozedUntil: null,
  assigneeId: null,
  projectId: null,
  cycleId: null,
  labelIds: null,
  number: 1,
  identifier: "PILE-1",
  repo: "VortexNYC/pile",
  branch: null,
  prUrl: null,
  prState: null,
  prCheckState: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const providerEnv: WorkerEnv = {
  ...env,
  DEVIN_ORG_ID: "devin-org",
  DEVIN_TOKEN: "test-token",
  OPENAI_API_KEY: "test-token",
  AGENT_PROVIDER_TOKEN: "test-token",
};

const requestSchema = z.object({
  prompt: z.union([z.string(), z.object({ text: z.string() })]).optional(),
  input: z
    .object({ content: z.array(z.object({ text: z.string() })) })
    .optional(),
});

const providers = [
  new DevinAgentProvider(providerEnv),
  new CodexAgentProvider(providerEnv),
  new CursorAgentProvider(providerEnv),
];

describe("domain review prompt delivery", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(providers)(
    "$id includes domain priming for code tasks",
    async (provider) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          session_id: "session-1",
          id: "session-1",
          agent: { id: "agent-1" },
          run: { id: "run-1", status: "CREATING" },
        })
      );

      await provider.dispatch("org-1", issue);

      const request = requestSchema.parse(
        JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
      );
      const prompt =
        typeof request.prompt === "string"
          ? request.prompt
          : (request.prompt?.text ?? request.input?.content[0]?.text ?? "");
      expect(prompt).toContain(issue.description);
      expect(prompt).toContain(DOMAIN_REVIEW_PROMPT);
    }
  );

  it.each(providers)(
    "$id omits code review for repo-less deliverables",
    async (provider) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          session_id: "session-1",
          id: "session-1",
          agent: { id: "agent-1" },
          run: { id: "run-1", status: "CREATING" },
        })
      );

      await provider.dispatch("org-1", { ...issue, repo: null });

      expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).not.toContain(
        "Domain-lens review"
      );
    }
  );
});

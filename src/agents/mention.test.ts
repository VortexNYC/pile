import { describe, expect, it } from "vitest";

import {
  buildMentionPrompt,
  isTrustedAssociation,
  parsePileMention,
} from "./mention.js";

describe("parsePileMention (PILE-278)", () => {
  it("extracts the request around a leading mention", () => {
    expect(parsePileMention("@pile fix the typo in your PR")).toEqual({
      request: "fix the typo in your PR",
    });
    expect(parsePileMention("@Pile, rebase please")?.request).toBe(
      "rebase please"
    );
  });

  it("matches a mention mid-sentence", () => {
    expect(parsePileMention("hey @pile can you add a test?")?.request).toBe(
      "hey can you add a test?"
    );
  });

  it("ignores lookalikes, emails, and paths", () => {
    expect(parsePileMention("@pile-bot fix it")).toBeNull();
    expect(parsePileMention("@piles of work")).toBeNull();
    expect(parsePileMention("mail ops@pile.dev")).toBeNull();
    expect(parsePileMention("see org/@pile/cli")).toBeNull();
    expect(parsePileMention("no mention here")).toBeNull();
  });

  it("ignores mentions in quotes and code", () => {
    expect(parsePileMention("> @pile fix the typo\n\nthanks!")).toBeNull();
    expect(parsePileMention("run `@pile fix`")).toBeNull();
    expect(parsePileMention("```\n@pile fix\n```")).toBeNull();
  });
});

describe("isTrustedAssociation", () => {
  it("allows repo owners, members, and collaborators only", () => {
    expect(isTrustedAssociation("OWNER")).toBe(true);
    expect(isTrustedAssociation("member")).toBe(true);
    expect(isTrustedAssociation("COLLABORATOR")).toBe(true);
    expect(isTrustedAssociation("CONTRIBUTOR")).toBe(false);
    expect(isTrustedAssociation("NONE")).toBe(false);
    expect(isTrustedAssociation(undefined)).toBe(false);
  });
});

describe("buildMentionPrompt", () => {
  it("carries the request and the most recent thread", () => {
    const thread = Array.from({ length: 12 }, (_, i) => ({
      author: `user${i}`,
      body: `comment ${i}`,
    }));
    const prompt = buildMentionPrompt({
      author: "alice",
      commentUrl: "https://github.com/o/r/pull/1#issuecomment-9",
      targetUrl: "https://github.com/o/r/pull/1",
      isPullRequest: true,
      request: "fix the typo",
      thread,
    });
    expect(prompt).toContain("alice mentioned @pile on pull request");
    expect(prompt).toContain("fix the typo");
    expect(prompt).toContain("comment 11");
    expect(prompt).not.toContain("comment 1\n");
    expect(prompt).toContain("push");
  });
});

// PILE-278 — `@pile` in a GitHub issue/PR comment is the human→lane
// interface ("@pile fix the typo in your PR"). Parsing and prompt shaping
// live here; routing (resolve issue → resume or dispatch lane) lives in the
// GitHub webhook processor.

const MENTION = /(^|[^\w@/.-])@pile(?![\w-])/i;

// Only people with write-ish standing on the repo can steer a lane — a
// drive-by commenter on a public repo must not be able to spend compute.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isTrustedAssociation(
  association: string | null | undefined
): boolean {
  return (
    association !== null &&
    association !== undefined &&
    TRUSTED_ASSOCIATIONS.has(association.toUpperCase())
  );
}

// Quoted replies and code samples routinely carry an old `@pile` — only a
// mention in the comment's own prose counts.
function stripQuotedAndCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** Returns the request text with the mention removed, or null when the
 *  comment doesn't address `@pile`. */
export function parsePileMention(body: string): { request: string } | null {
  if (!MENTION.test(stripQuotedAndCode(body))) return null;
  const request = body
    .replace(new RegExp(`${MENTION.source}[ \\t]*`, "gi"), "$1")
    .replace(/^[\s,:;-]+/, "")
    .trim();
  return { request };
}

export interface MentionThreadEntry {
  author: string;
  body: string;
}

const THREAD_LIMIT = 10;
const ENTRY_CHARS = 1500;

export function buildMentionPrompt(input: {
  author: string;
  commentUrl: string;
  targetUrl: string;
  isPullRequest: boolean;
  request: string;
  thread: MentionThreadEntry[];
}): string {
  const where = input.isPullRequest ? "pull request" : "issue";
  const recent = input.thread.slice(-THREAD_LIMIT);
  const lines = [
    `${input.author} mentioned @pile on ${where} ${input.targetUrl} (${input.commentUrl}):`,
    "",
    input.request || "(no request text — read the thread for what's needed)",
  ];
  if (recent.length > 0) {
    lines.push("", "Recent thread (oldest first):");
    for (const entry of recent) {
      const body =
        entry.body.length > ENTRY_CHARS
          ? `${entry.body.slice(0, ENTRY_CHARS)}…`
          : entry.body;
      lines.push(`--- ${entry.author}`, body);
    }
  }
  lines.push(
    "",
    input.isPullRequest
      ? "Act on the request on this PR's branch and push."
      : "Act on the request; open or update the PR for this issue."
  );
  return lines.join("\n");
}

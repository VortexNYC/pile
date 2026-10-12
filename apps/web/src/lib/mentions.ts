import type { MentionTarget } from "@/components/composer";

type MemberRow = {
  id?: string;
  userId?: string;
  user?: { id: string; name: string; email: string } | null;
};

// better-auth listMembers rows — user is the identity payload; fall back
// to the row's own fields for API-key-ish members.
export function mentionTargets(
  members: readonly MemberRow[] | undefined
): MentionTarget[] {
  return (members ?? [])
    .map((m) => {
      const u = m.user;
      if (u && typeof u.id === "string") {
        return { id: u.id, name: u.name, email: u.email };
      }
      return null;
    })
    .filter((u): u is MentionTarget => u !== null);
}

const MENTION_TAIL_RE = /@([a-zA-Z0-9._-]{0,})$/;

// The "@handle" currently being typed at the end of the composer text —
// null when the caret isn't inside a mention token.
export function mentionQuery(text: string): string | null {
  const m = MENTION_TAIL_RE.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
}

// Candidate handles for a member — mirrors the API's resolveMentions
// grammar (name-space-stripped, name-dash, email local part).
export function mentionHandles(target: MentionTarget): string[] {
  return [
    target.name.toLowerCase().replace(/\s+/g, ""),
    target.name.toLowerCase().replace(/\s+/g, "-"),
    (target.email.split("@")[0] ?? "").toLowerCase(),
  ];
}

export function filterMentionTargets(
  targets: readonly MentionTarget[],
  query: string,
  max = 6
): MentionTarget[] {
  const needle = query.toLowerCase();
  return targets
    .filter(
      (m) =>
        needle === "" || mentionHandles(m).some((h) => h.startsWith(needle))
    )
    .slice(0, max);
}

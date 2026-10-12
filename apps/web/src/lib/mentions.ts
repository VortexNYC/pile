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

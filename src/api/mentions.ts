import { eq, inArray } from "drizzle-orm";

import type { D1Client } from "../global/db.js";
import { member, user } from "../global/schema.js";

const MENTION_RE = /@([a-zA-Z0-9._-]{2,})/g;

// Resolve @handle mentions in comment text to org member user ids.
// Handles match user.id, user.name (space-insensitive), or the email
// local part. Mentions only resolve inside the organization.
export async function resolveMentions(
  db: D1Client,
  organizationId: string,
  body: string
): Promise<string[]> {
  const handles = new Set(
    [...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase())
  );
  if (handles.size === 0) return [];
  const members = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .all();
  if (members.length === 0) return [];
  const users = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(
      inArray(
        user.id,
        members.map((m) => m.userId)
      )
    )
    .all();
  const resolved = new Set<string>();
  for (const u of users) {
    const candidates = new Set([
      u.id.toLowerCase(),
      u.name.toLowerCase().replace(/\s+/g, ""),
      u.name.toLowerCase().replace(/\s+/g, "-"),
      u.email.split("@")[0].toLowerCase(),
    ]);
    for (const handle of handles) {
      if (candidates.has(handle)) resolved.add(u.id);
    }
  }
  return [...resolved];
}

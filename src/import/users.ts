import { createUser, findUserByEmail } from "../global/users.js";
import type { ImportContext } from "./types.js";
import { unwrap } from "./utils.js";

export async function getOrCreateUser(
  ctx: ImportContext,
  cache: Map<string, string | null>,
  accountId?: string,
  email?: string,
  name?: string
): Promise<string | null> {
  if (!accountId && !email) return null;
  const key = accountId ?? email ?? "";
  if (cache.has(key)) return cache.get(key) ?? null;

  if (email) {
    const existing = await findUserByEmail(ctx.db, email);
    if (existing) {
      cache.set(key, existing.id);
      if (accountId) cache.set(accountId, existing.id);
      return existing.id;
    }
  }

  if (email && name) {
    const created = unwrap(
      await createUser(ctx.db, { name, email, emailVerified: true }),
      "Failed to create user"
    );
    cache.set(key, created.id);
    if (accountId) cache.set(accountId, created.id);
    return created.id;
  }

  cache.set(key, null);
  return null;
}

import type { AppEnv } from "./env.js";
import { sessionHeadersForUser } from "./session.js";

/**
 * Return headers that authenticate `userId` as a real Better Auth session.
 * This is intended for tests and internal setup where a real browser
 * sign-in is not available. (This used to mint an API key and rely on
 * key-as-session, which only resolves on /get-session now.)
 */
export async function createAdminHeaders(
  env: AppEnv,
  userId: string
): Promise<Headers> {
  const headers = await sessionHeadersForUser(env, userId);
  // Cookie-authenticated mutating requests need a trusted Origin to pass
  // the CSRF middleware; the auth base URL is always trusted.
  if (env.BETTER_AUTH_URL) {
    headers.set("Origin", env.BETTER_AUTH_URL);
  }
  return headers;
}

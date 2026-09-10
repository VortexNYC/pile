import { z } from "zod";

import { createAuth } from "./auth.js";
import type { AppEnv } from "./env.js";

/**
 * Create a temporary API key for `userId` and return headers that
 * authenticate as that user. This is intended for tests and internal
 * setup where a real browser session is not available.
 */
export async function createAdminHeaders(
  env: AppEnv,
  userId: string
): Promise<Headers> {
  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return new Headers({ Authorization: `Bearer ${parsed.key}` });
}

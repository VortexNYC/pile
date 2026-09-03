import { z } from "zod";

import { createAuth } from "./auth.js";
import type { AppEnv } from "./env.js";

const sessionResponseSchema = z.object({
  user: z.object({ id: z.string() }),
});

export async function getSessionUserId(
  env: AppEnv,
  request: Request
): Promise<string | null> {
  if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
    return null;
  }

  try {
    const auth = createAuth(env);
    const result = await auth.api.getSession({
      headers: request.headers,
    });
    if (!result || result instanceof Response) {
      return null;
    }
    const parsed = sessionResponseSchema.safeParse(result);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.user.id;
  } catch {
    return null;
  }
}

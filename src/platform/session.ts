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
    const auth = await createAuth(env);
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

// Matches better-auth's signed-cookie format: `${value}.${base64(HMAC-SHA256)}`
// verified by better-call's getSignedCookie.
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${value}.${base64}`;
}

/**
 * Mint a real Better Auth session for `userId` and return headers carrying
 * the signed `better-auth.session_token` cookie. Server code calls
 * `auth.api.*` endpoints that only understand sessions; API-key callers no
 * longer synthesize one outside /get-session, so callers we have already
 * verified (the key's owner) get a session minted here instead.
 */
export async function sessionHeadersForUser(
  env: AppEnv,
  userId: string
): Promise<Headers> {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET not configured");
  }
  const auth = await createAuth(env);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId);
  const signed = await signCookieValue(session.token, env.BETTER_AUTH_SECRET);
  return new Headers({
    Cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`,
  });
}

/**
 * Headers for forwarding to `auth.api.*` endpoints that need a session.
 * Cookie sessions pass through unchanged; a Bearer API key is swapped for
 * a session minted for `userId` (the key's verified owner) so org-scoped
 * endpoints see the same principal the workspace layer resolved.
 */
export async function sessionHeadersForAuthApi(
  env: AppEnv,
  requestHeaders: Headers,
  userId: string
): Promise<Headers> {
  const authorization = requestHeaders.get("Authorization") ?? "";
  if (!/^Bearer\s+\S/i.test(authorization)) {
    return requestHeaders;
  }
  const headers = new Headers(requestHeaders);
  headers.delete("Authorization");
  headers.delete("Cookie");
  for (const [name, value] of await sessionHeadersForUser(env, userId)) {
    headers.set(name, value);
  }
  return headers;
}

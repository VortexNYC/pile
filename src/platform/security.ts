import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";

import type { AppEnv } from "./env.js";
import { VortexError } from "./errors.js";
import type { AppContext } from "./middleware.js";

const UNSAFE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function allowedOrigins(env: AppEnv): Set<string> {
  const set = new Set<string>();
  if (env.BETTER_AUTH_URL) {
    try {
      set.add(new URL(env.BETTER_AUTH_URL).origin);
    } catch {
      // ignore invalid URL
    }
  }
  if (env.ALLOWED_ORIGINS) {
    for (const o of env.ALLOWED_ORIGINS.split(",")) {
      const t = o.trim();
      if (t) set.add(t);
    }
  }
  return set;
}

function normalizeOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/github" ||
    pathname === "/gitlab" ||
    pathname.startsWith("/slack/") ||
    pathname.startsWith("/api/auth") ||
    pathname.includes("/migrate/") ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/notion/") ||
    pathname.startsWith("/support/webhooks/") ||
    pathname.startsWith("/support/incoming/") ||
    pathname.startsWith("/support/capture/")
  );
}

function isAllowedOrigin(
  origin: string,
  env: AppEnv,
  pathname: string
): boolean {
  if (isPublicPath(pathname)) {
    return true;
  }
  const allowed = allowedOrigins(env);
  if (allowed.size === 0) {
    return true;
  }
  return allowed.has(origin) || allowed.has(normalizeOrigin(origin));
}

export const corsMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const origin = c.req.header("origin") ?? "";
  if (isAllowedOrigin(origin, c.env, c.req.path) && origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, PUT, DELETE, OPTIONS"
    );
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Requested-With"
    );
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Max-Age", "86400");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

export const csrfMiddleware = createMiddleware<AppContext>(async (c, next) => {
  if (isPublicPath(c.req.path)) {
    await next();
    return;
  }

  // CSRF targets ambient cookie auth. Bearer-token requests carry explicit
  // credentials and cannot be forged cross-origin, so skip the origin check.
  const hasBearer = Boolean(c.req.header("authorization")?.trim());

  if (UNSAFE_METHODS.has(c.req.method) && !hasBearer) {
    const origin = c.req.header("origin") ?? c.req.header("referer") ?? "";
    if (!isAllowedOrigin(origin, c.env, c.req.path)) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Origin not allowed",
      });
    }
  }

  await next();
});

export const securityMiddleware = [
  secureHeaders(),
  corsMiddleware,
  csrfMiddleware,
];

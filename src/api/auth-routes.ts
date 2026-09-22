import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TypedResponse } from "hono";

import { createAuth } from "../platform/auth.js";
import type { AppContext } from "../platform/middleware.js";

const authBodySchema = z
  .record(z.string(), z.unknown())
  .openapi({ description: "Better Auth request body" });

const authQuerySchema = z
  .object({})
  .passthrough()
  .openapi({ description: "Better Auth query parameters" });

const authTokenParamSchema = z.object({
  token: z.string(),
});

const authResponseSchema = z.string().openapi({
  description: "Better Auth raw response (JSON or HTML)",
});

const endpoints = [
  { method: "post", path: "/api/auth/sign-up/email", fn: "signUpEmail" },
  { method: "post", path: "/api/auth/sign-in/email", fn: "signInEmail" },
  { method: "post", path: "/api/auth/sign-out", fn: "signOut" },
  { method: "get", path: "/api/auth/get-session", fn: "getSession" },
  { method: "get", path: "/api/auth/list-sessions", fn: "listSessions" },
  { method: "post", path: "/api/auth/revoke-session", fn: "revokeSession" },
  { method: "post", path: "/api/auth/revoke-sessions", fn: "revokeSessions" },
  {
    method: "post",
    path: "/api/auth/request-password-reset",
    fn: "requestPasswordReset",
  },
  { method: "post", path: "/api/auth/reset-password", fn: "resetPassword" },
  {
    method: "get",
    path: "/api/auth/reset-password/{token}",
    fn: "requestPasswordResetCallback",
    hasParams: true,
    hasQuery: true,
  },
  {
    method: "post",
    path: "/api/auth/send-verification-email",
    fn: "sendVerificationEmail",
  },
  {
    method: "get",
    path: "/api/auth/verify-email",
    fn: "verifyEmail",
    hasQuery: true,
  },
  { method: "post", path: "/api/auth/change-password", fn: "changePassword" },
  { method: "post", path: "/api/auth/change-email", fn: "changeEmail" },
  { method: "post", path: "/api/auth/update-user", fn: "updateUser" },
  { method: "post", path: "/api/auth/delete-user", fn: "deleteUser" },
  { method: "post", path: "/api/auth/verify-password", fn: "verifyPassword" },
  { method: "post", path: "/api/auth/admin/set-role", fn: "setRole" },
  {
    method: "get",
    path: "/api/auth/admin/get-user",
    fn: "getUser",
    hasQuery: true,
  },
  {
    method: "post",
    path: "/api/auth/admin/create-user",
    fn: "createUser",
  },
  {
    method: "post",
    path: "/api/auth/admin/update-user",
    fn: "adminUpdateUser",
  },
  {
    method: "get",
    path: "/api/auth/admin/list-users",
    fn: "listUsers",
    hasQuery: true,
  },
  {
    method: "post",
    path: "/api/auth/admin/list-user-sessions",
    fn: "listUserSessions",
  },
  { method: "post", path: "/api/auth/admin/unban-user", fn: "unbanUser" },
  { method: "post", path: "/api/auth/admin/ban-user", fn: "banUser" },
  {
    method: "post",
    path: "/api/auth/admin/impersonate-user",
    fn: "impersonateUser",
  },
  {
    method: "post",
    path: "/api/auth/admin/stop-impersonating",
    fn: "stopImpersonating",
  },
  {
    method: "post",
    path: "/api/auth/admin/revoke-user-session",
    fn: "revokeUserSession",
  },
  {
    method: "post",
    path: "/api/auth/admin/revoke-user-sessions",
    fn: "revokeUserSessions",
  },
  { method: "post", path: "/api/auth/admin/remove-user", fn: "removeUser" },
  {
    method: "post",
    path: "/api/auth/admin/set-user-password",
    fn: "setUserPassword",
  },
  {
    method: "post",
    path: "/api/auth/admin/has-permission",
    fn: "userHasPermission",
  },
] as const;

type Endpoint = (typeof endpoints)[number];

function buildRoute(endpoint: Endpoint) {
  const request: {
    body?: {
      content: { "application/json": { schema: typeof authBodySchema } };
    };
    params?: typeof authTokenParamSchema;
    query?: typeof authQuerySchema;
  } = {};

  if (endpoint.method === "post") {
    request.body = {
      content: { "application/json": { schema: authBodySchema } },
    };
  }
  if ("hasParams" in endpoint && endpoint.hasParams) {
    request.params = authTokenParamSchema;
  }
  if ("hasQuery" in endpoint && endpoint.hasQuery) {
    request.query = authQuerySchema;
  }

  return createRoute({
    method: endpoint.method,
    path: endpoint.path,
    operationId: endpoint.fn,
    tags: ["Auth"],
    request,
    responses: {
      200: {
        description: "Success",
        content: { "text/plain": { schema: authResponseSchema } },
      },
    },
  });
}

export function registerAuthRoutes(app: OpenAPIHono<AppContext>) {
  for (const endpoint of endpoints) {
    const route = buildRoute(endpoint);
    app.openapi(route, async (c) => {
      const auth = createAuth(c.env);

      const body =
        endpoint.method === "post"
          ? ((await c.req.json()) as Record<string, unknown>)
          : undefined;
      const headers = new Headers(c.req.raw.headers);
      // Body is re-serialized below, so a stale content-length could truncate it.
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      const result = await auth.handler(
        new Request(c.req.url, {
          method: c.req.method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      );

      return new Response(await result.text(), {
        status: result.status,
        headers: result.headers,
      }) as unknown as TypedResponse<string, 200, "text">;
    });
  }
}

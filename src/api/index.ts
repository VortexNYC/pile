import { Hono } from "hono";
import { VortexError, toErrorResponse } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import { workspaceTokenMiddleware } from "./middleware.js";
import { issueRoutes } from "./issues.js";
import { githubRoutes } from "../agents/github.js";
import { createAuth } from "../platform/auth.js";

const app = new Hono<{ Bindings: AppEnv }>();

app.onError((err) => {
  return toErrorResponse(err);
});

app.use("/workspaces/:workspaceId/*", workspaceTokenMiddleware);
app.route("/workspaces/:workspaceId/issues", issueRoutes);

app.get("/workspaces/:workspaceId/ws", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "workspaceId is required",
    });
  }
  const id = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(id);
  return await stub.fetch(c.req.raw);
});

app.route("/github", githubRoutes);

app.all("/api/auth/*", (c) => {
  return createAuth(c.env).handler(c.req.raw);
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;

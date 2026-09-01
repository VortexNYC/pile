import { Hono } from "hono";
import { VortexError, toErrorResponse } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import { workspaceTokenMiddleware } from "./middleware.js";
import { issueRoutes } from "./issues.js";

const app = new Hono<{ Bindings: AppEnv }>();

app.onError((err) => {
  return toErrorResponse(err);
});

app.use("/workspaces/:workspaceId/*", workspaceTokenMiddleware);
app.route("/workspaces/:workspaceId/issues", issueRoutes);

app.get("/health", (c) => c.json({ ok: true }));

export default app;

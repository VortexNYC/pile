import { Hono } from "hono";
import { z } from "zod";
import { createD1 } from "../global/db.js";
import { findRepoBranch } from "../global/repo-branches.js";
import { hmacSha256Hex, timingSafeEqualHex } from "../platform/crypto.js";
import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import type { WorkspaceDurableObjectStub } from "../workspace/types.js";

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    state: z.string(),
    html_url: z.string(),
    head: z.object({
      ref: z.string(),
      repo: z.object({
        full_name: z.string(),
      }),
    }),
  }),
});

const app = new Hono<{ Bindings: AppEnv }>();

app.post("/", async (c) => {
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const rawBody = await c.req.text();

  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const expected = `sha256=${await hmacSha256Hex(
      c.env.GITHUB_WEBHOOK_SECRET,
      rawBody
    )}`;
    if (!timingSafeEqualHex(signature, expected)) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid GitHub signature",
      });
    }
  }

  const event = c.req.header("x-github-event");
  if (event !== "pull_request") {
    return c.json({ ok: true });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const payload = pullRequestPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid pull_request payload",
      hint: payload.error.message,
    });
  }

  const { pull_request } = payload.data;
  const repo = pull_request.head.repo.full_name;
  const branch = pull_request.head.ref;
  const prUrl = pull_request.html_url;
  const prState = pull_request.state;

  const db = createD1(c.env.D1);
  const record = await findRepoBranch(db, repo, branch);
  if (!record) {
    return c.json({ ok: true });
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(record.workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
    doId
  ) as unknown as WorkspaceDurableObjectStub;
  await stub.updatePrState(repo, branch, prUrl, prState);

  return c.json({ ok: true });
});

export { app as githubRoutes };

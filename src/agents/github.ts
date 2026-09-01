import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createD1 } from "../global/db.js";
import { findRepoBranch } from "../global/repo-branches.js";
import { hmacSha256Hex, timingSafeEqualHex } from "../platform/crypto.js";
import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../platform/env.js";
import type { WorkspaceToken } from "../api/middleware.js";

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

export const githubWebhookRoute = createRoute({
  method: "post",
  path: "/github",
  tags: ["github"],
  responses: {
    200: {
      description: "Webhook processed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
});

export async function processGithubWebhook(
  c: Context<{ Bindings: AppEnv; Variables: { workspaceToken: WorkspaceToken } }>
): Promise<{ ok: true }> {
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
    return { ok: true };
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
    return { ok: true };
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(record.workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.updatePrState(repo, branch, prUrl, prState);

  return { ok: true };
}

import type {
  ForwardableEmailMessage,
  MessageBatch,
} from "@cloudflare/workers-types";
import { ne } from "drizzle-orm";

import { sweepAgentSessions } from "./agents/sweep.js";
import app from "./api/index.js";
import { handleIncomingEmail } from "./channels/email.js";
import { createD1 } from "./global/db.js";
import { cycles } from "./global/schema.js";
import { expireStaleCaptureSessions } from "./global/support-capture.js";
import { webhookProcessors } from "./global/webhook-processors.js";
import {
  processWebhookQueueBatch,
  reprocessStuckDeliveries,
} from "./global/webhook-queue.js";
import type { WorkerEnv } from "./platform/middleware.js";

export { WorkspaceDO } from "./workspace/durable-object.js";
import { Sandbox } from "@cloudflare/sandbox";

// Per-provider sandbox classes — each maps to its own image/binding so a
// workload only carries the CLI it needs.
export class CursorSandbox extends Sandbox {}
export class DevinSandbox extends Sandbox {}
export class CodexSandbox extends Sandbox {}
export { Sandbox };

async function scheduled(
  _event: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext
) {
  ctx.waitUntil(
    sweepAgentSessions(env, ctx).catch((err) =>
      console.error("agent session sweep failed", err)
    )
  );
  ctx.waitUntil(
    (async () => {
      const d1 = createD1(env.D1);
      await expireStaleCaptureSessions(d1);
      await reprocessStuckDeliveries(d1, env);
    })().catch((err) => console.error("capture session sweep failed", err))
  );
  const d1 = createD1(env.D1);
  // Only wake DOs for orgs that have a non-completed cycle; orgs without
  // cycles never need a rollover pass.
  const orgs = await d1
    .selectDistinct({ id: cycles.organizationId })
    .from(cycles)
    .where(ne(cycles.status, "completed"))
    .all();
  ctx.waitUntil(
    Promise.all(
      orgs.map(async (org) => {
        try {
          const stub = env.WORKSPACE_DURABLE_OBJECT.get(
            env.WORKSPACE_DURABLE_OBJECT.idFromName(org.id)
          );
          await stub.setOrganizationId(org.id);
          const result = await stub.rolloverCycles();
          if (result.completedCycles.length > 0) {
            console.log("cycle rollover", {
              organizationId: org.id,
              ...result,
            });
          }
        } catch (error) {
          console.error("cycle rollover failed", {
            organizationId: org.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
    )
  );
}

async function email(
  message: ForwardableEmailMessage,
  env: WorkerEnv,
  _ctx: ExecutionContext
) {
  try {
    await handleIncomingEmail(message, env);
  } catch (err) {
    console.error("incoming email processing failed", {
      to: typeof message.to === "string" ? message.to : undefined,
      from: typeof message.from === "string" ? message.from : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function queue(
  batch: MessageBatch,
  env: WorkerEnv,
  _ctx: ExecutionContext
) {
  try {
    await processWebhookQueueBatch(batch, env, webhookProcessors);
  } catch (err) {
    console.error("webhook queue batch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export default {
  fetch: app.fetch.bind(app),
  scheduled,
  email,
  queue,
} satisfies ExportedHandler<WorkerEnv>;

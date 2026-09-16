import type {
  ForwardableEmailMessage,
  MessageBatch,
} from "@cloudflare/workers-types";
import { ne } from "drizzle-orm";

import { getAgentProvider } from "./agents/index.js";
import {
  drainOutpostQueue,
  resolveAgentEnv,
  sweepOutpostWorkers,
} from "./agents/outpost.js";
import app from "./api/index.js";
import { handleIncomingEmail } from "./channels/email.js";
import { createD1 } from "./global/db.js";
import { cycles, organization } from "./global/schema.js";
import { expireStaleCaptureSessions } from "./global/support-capture.js";
import { webhookProcessors } from "./global/webhook-processors.js";
import {
  processWebhookQueueBatch,
  reprocessStuckDeliveries,
} from "./global/webhook-queue.js";
import type { WorkerEnv } from "./platform/middleware.js";

export { WorkspaceDO } from "./workspace/durable-object.js";

async function scheduled(
  _event: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext
) {
  ctx.waitUntil(
    drainOutpostQueue(env)
      .then(() => sweepOutpostWorkers(env))
      .then(() => sweepAgentSessions(env))
      .catch((err) => console.error("outpost sweep failed", err))
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

const DEFAULT_TIMEOUT_MINUTES = 60;

async function sweepAgentSessions(env: WorkerEnv): Promise<void> {
  const d1 = createD1(env.D1);
  const orgs = await d1
    .select({ id: organization.id })
    .from(organization)
    .all();
  const now = Date.now();
  for (const { id } of orgs) {
    try {
      const stub = env.WORKSPACE_DURABLE_OBJECT.get(
        env.WORKSPACE_DURABLE_OBJECT.idFromName(id)
      );
      await stub.setOrganizationId(id);
      const sessions = await stub.listAgentSessions({ status: "running" });
      if (sessions.length === 0) continue;
      for (const session of sessions) {
        const providerConfig = await stub.getAgentProviderConfig(
          session.agentId
        );
        const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
        let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
        if (providerConfig?.config) {
          try {
            const parsed: unknown = JSON.parse(providerConfig.config);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "timeout" in parsed &&
              typeof (parsed as Record<string, unknown>).timeout === "number"
            ) {
              timeoutMinutes = (parsed as Record<string, unknown>)
                .timeout as number;
            }
          } catch {
            /* invalid JSON */
          }
        }
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const started = new Date(session.createdAt).getTime();
        if (now - started < timeoutMs) continue;
        const provider = getAgentProvider(session.agentId, effectiveEnv);
        const remoteId = session.providerSessionId ?? session.id;
        try {
          if (provider.cancel) await provider.cancel(remoteId);
        } catch (err) {
          console.error("agent session cancel failed", {
            session: session.id,
            agentId: session.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await stub.applyAgentSessionResult(
          session.id,
          {
            status: "canceled",
            result: `session timed out after ${timeoutMinutes}m`,
            url: session.url ?? null,
            prUrl: session.prUrl ?? null,
            prState: session.prState ?? null,
          },
          undefined
        );
      }
    } catch (err) {
      console.error("agent session sweep failed", {
        organizationId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

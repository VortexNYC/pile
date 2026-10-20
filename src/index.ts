import { ne } from "drizzle-orm";

import { createD1 } from "./global/db.js";
import { cycles } from "./global/schema.js";
import type { WorkerEnv } from "./platform/middleware.js";

export { WorkspaceDO } from "./workspace/durable-object.js";
import { Sandbox } from "@cloudflare/sandbox";

// Per-provider sandbox classes — each maps to its own image/binding so a
// workload only carries the CLI it needs.
export class CursorSandbox extends Sandbox {}
export class DevinSandbox extends Sandbox {}
export class CodexSandbox extends Sandbox {}
export { Sandbox };

// sandbox-sdk 1.0 lane pools — new classes/bindings alongside the 0.12 set
// (a scheduling_policy move is one-way, so the old classes stay for
// rollback). Selected per-lane via LANE_SDK=v1.
export {
  LaneCodexSandbox,
  LaneCursorSandbox,
  LaneDevinSandbox,
  LaneSandbox,
} from "./agents/lane-sandbox.js";

// The API graph is ~80 route modules — importing it at module init blows the
// 400ms startup cap. Defer evaluation to the first request; the promise caches
// per isolate so steady-state requests pay nothing.
type AppModule = typeof import("./api/index.js");
let appPromise: Promise<AppModule["default"]> | undefined;
function loadApp() {
  appPromise ??= import("./api/index.js").then((m) => m.default);
  return appPromise;
}

async function scheduled(
  _event: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext
) {
  ctx.waitUntil(
    import("./agents/sweep.js").then(({ sweepAgentSessions }) =>
      sweepAgentSessions(env, ctx).catch((err) =>
        console.error("agent session sweep failed", err)
      )
    )
  );
  ctx.waitUntil(
    (async () => {
      const { expireStaleCaptureSessions, sweepExpiredCaptureArtifacts } =
        await import("./global/support-capture.js");
      const { reprocessStuckDeliveries } =
        await import("./global/webhook-queue.js");
      const d1 = createD1(env.D1);
      await expireStaleCaptureSessions(d1);
      const retentionDays = Number(env.CAPTURE_ARTIFACT_RETENTION_DAYS ?? "30");
      if (Number.isFinite(retentionDays) && retentionDays > 0) {
        const { removed } = await sweepExpiredCaptureArtifacts(
          d1,
          env.ATTACHMENTS_BUCKET,
          retentionDays
        );
        if (removed > 0) {
          console.log("capture artifact retention sweep", { removed });
        }
      }
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
    const { handleIncomingEmail } = await import("./channels/email.js");
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
    const [{ processWebhookQueueBatch }, { webhookProcessors }] =
      await Promise.all([
        import("./global/webhook-queue.js"),
        import("./global/webhook-processors.js"),
      ]);
    await processWebhookQueueBatch(batch, env, webhookProcessors);
  } catch (err) {
    console.error("webhook queue batch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext) {
    const app = await loadApp();
    return app.fetch(request, env, ctx);
  },
  scheduled,
  email,
  queue,
} satisfies ExportedHandler<WorkerEnv>;

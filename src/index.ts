import app from "./api/index.js";
import { createD1 } from "./global/db.js";
import { organization } from "./global/schema.js";
import type { WorkerEnv } from "./platform/middleware.js";

export { WorkspaceDO } from "./workspace/durable-object.js";

async function scheduled(
  _event: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext
) {
  const d1 = createD1(env.D1);
  const orgs = await d1
    .select({ id: organization.id })
    .from(organization)
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

export default {
  fetch: app.fetch.bind(app),
  scheduled,
} satisfies ExportedHandler<WorkerEnv>;

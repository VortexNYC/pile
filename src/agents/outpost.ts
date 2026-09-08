import { z } from "@hono/zod-openapi";

import type { WorkerEnv } from "../platform/middleware.js";

const daytonaSandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
});

const outpostQueueSchema = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ session_id: z.string() }),
      status: z.object({ phase: z.string() }),
    })
  ),
});

const devinSessionSchema = z.object({
  session_id: z.string(),
  status: z.string(),
});

function daytonaConfig(env: WorkerEnv) {
  const apiKey = env.DAYTONA_API_KEY;
  const apiUrl = env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
  if (!apiKey) return null;
  return { apiKey, apiUrl };
}

/**
 * Provision a dedicated Daytona sandbox that claims and serves one outpost
 * session. The sandbox snapshot runs `devin worker start --session <id>` as
 * its entrypoint, so the worker picks up exactly this session and exits when
 * it ends.
 */
export async function provisionOutpostWorker(
  env: WorkerEnv,
  devinSessionId: string
): Promise<void> {
  const fleetId = devinSessionId.startsWith("devin-")
    ? devinSessionId
    : `devin-${devinSessionId}`;
  const config = daytonaConfig(env);
  const outpostId = env.DEVIN_OUTPOST_ID;
  const outpostToken = env.DEVIN_OUTPOST_TOKEN;
  if (!config || !outpostId || !outpostToken) return;

  const res = await fetch(`${config.apiUrl}/sandbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `vortex-outpost-${devinSessionId.replace(/^devin-/, "").slice(0, 12)}`,
      snapshot: env.DAYTONA_SNAPSHOT ?? "vortex-outpost-worker",
      env: {
        OUTPOST_ID: outpostId,
        OUTPOST_TOKEN: outpostToken,
        SESSION_ID: fleetId,
      },
      labels: {
        "vortex.outpost": "1",
        "vortex.session": fleetId,
      },
      autoStopInterval: 0,
      autoDeleteInterval: 0,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("daytona sandbox create failed", {
      session: fleetId,
      status: res.status,
      body: text.slice(0, 500),
    });
    return;
  }

  const sandbox = daytonaSandboxSchema.parse(await res.json());
  console.log("outpost worker provisioned", {
    session: devinSessionId,
    sandbox: sandbox.id,
  });
}

/**
 * Cron sweeper: delete outpost sandboxes whose Devin session has reached a
 * terminal state. Sessions run to completion inside the sandbox; once Devin
 * reports exit/error/suspended, the sandbox is reclaimed.
 */
export async function sweepOutpostWorkers(env: WorkerEnv): Promise<void> {
  const config = daytonaConfig(env);
  const orgId = env.DEVIN_ORG_ID;
  if (!config || !orgId || !env.DEVIN_TOKEN) return;

  const res = await fetch(`${config.apiUrl}/sandbox`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) {
    console.error("daytona sandbox list failed", res.status);
    return;
  }
  const list = z
    .object({ items: z.array(daytonaSandboxSchema) })
    .parse(await res.json());

  const workers = list.items.filter(
    (s) =>
      s.labels?.["vortex.outpost"] === "1" &&
      s.labels["vortex.session"] &&
      s.state !== "destroyed" &&
      s.state !== "archived"
  );

  await Promise.all(
    workers.map(async (sandbox) => {
      const sessionId = sandbox.labels?.["vortex.session"];
      if (!sessionId) return;
      const sessionRes = await fetch(
        `https://api.devin.ai/v3/organizations/${orgId}/sessions/${sessionId.replace(/^devin-/, "")}`,
        { headers: { Authorization: `Bearer ${env.DEVIN_TOKEN}` } }
      );
      if (!sessionRes.ok) return;
      const session = devinSessionSchema.parse(await sessionRes.json());
      if (["exit", "error", "suspended", "blocked"].includes(session.status)) {
        const del = await fetch(`${config.apiUrl}/sandbox/${sandbox.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        console.log("outpost worker reaped", {
          session: sessionId,
          sandbox: sandbox.id,
          ok: del.ok,
        });
      }
    })
  );
}

/**
 * Backstop for queued sessions that never got a worker provisioned (e.g. a
 * dispatch that predates provisioning, or a failed create). Lists the
 * outpost's pending sessions and provisions a worker for each.
 */
export async function drainOutpostQueue(env: WorkerEnv): Promise<void> {
  const outpostId = env.DEVIN_OUTPOST_ID;
  const outpostToken = env.DEVIN_OUTPOST_TOKEN;
  if (!outpostId || !outpostToken || !env.DEVIN_TOKEN) return;

  const res = await fetch(
    `https://api.devin.ai/opbeta/outposts/devins?outpost=${encodeURIComponent(outpostId)}&phase=pending`,
    { headers: { Authorization: `Bearer ${outpostToken}` } }
  );
  if (!res.ok) {
    console.error("outpost queue list failed", res.status);
    return;
  }
  const queue = outpostQueueSchema.parse(await res.json());
  await Promise.all(
    queue.items.map((item) =>
      provisionOutpostWorker(env, item.metadata.session_id)
    )
  );
}

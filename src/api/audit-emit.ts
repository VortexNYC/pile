import type { Context } from "hono";

import type { AppContext } from "../platform/middleware.js";
import { getWorkspaceStub } from "./stub.js";

// Audit write for API-layer events (token create/revoke, member changes,
// workspace settings) that live outside the workspace DO. The entry lands in
// the org's audit_log and fans out to webhook subscribers as an `audit.entry`
// event for SIEM. Awaited by callers so entries land before the response;
// failures are swallowed so audit never breaks the request path.
export async function emitWorkspaceAudit(
  c: Context<AppContext>,
  organizationId: string,
  action: string,
  entityType: string,
  entityId: string,
  changes?: Record<string, { from: unknown; to: unknown }> | null
) {
  const identity = c.var.workspaceIdentity;
  const stub = getWorkspaceStub(c.env, organizationId);
  try {
    await stub.recordAudit(
      action,
      entityType,
      entityId,
      identity?.id ?? null,
      changes ?? null,
      {
        actorType: identity?.type ?? null,
        ip: c.req.header("cf-connecting-ip") ?? null,
        country: c.req.header("cf-ipcountry") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      }
    );
  } catch {
    // Audit failure must not break the request path.
  }
}

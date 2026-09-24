import { and, eq, sql } from "drizzle-orm";

import type { WorkerEnv } from "../platform/middleware.js";
import type { D1Client } from "./db.js";
import {
  organization,
  supportCustomers,
  supportTicketAttachments,
  supportWidgetSessions,
} from "./schema.js";

type OrgTable = { name: string; sql: string };

/**
 * Deletes every row scoped to an organization across all D1 tables, the
 * org's R2 attachment objects, and the workspace Durable Object's storage.
 * Table discovery is driven by sqlite_master so new org-scoped tables are
 * covered automatically; delete order is children-first by declared FK refs.
 */
export async function deleteWorkspaceData(
  db: D1Client,
  env: WorkerEnv,
  organizationId: string
): Promise<{ r2Objects: number; tables: Record<string, number> }> {
  const keyRows = await db
    .select({ r2Key: supportTicketAttachments.r2Key })
    .from(supportTicketAttachments)
    .where(eq(supportTicketAttachments.organizationId, organizationId))
    .all();
  const r2Keys = keyRows
    .map((r) => r.r2Key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  for (let i = 0; i < r2Keys.length; i += 500) {
    await env.ATTACHMENTS_BUCKET.delete(r2Keys.slice(i, i + 500));
  }

  const tables = await db.all<OrgTable>(
    sql`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'`
  );
  // Column-verified scoping: a table is org-scoped only if it actually has an
  // organization_id column (session.active_organization_id is a pointer, not
  // an owner column — it is swept separately below).
  const orgScoped: OrgTable[] = [];
  const pointerTables: string[] = [];
  const columnSets = await Promise.all(
    tables.map((t) =>
      db.all<{ name: string }>(
        sql`SELECT name FROM pragma_table_info(${t.name})`
      )
    )
  );
  tables.forEach((t, i) => {
    const colNames = new Set(columnSets[i].map((c) => c.name));
    if (colNames.has("organization_id")) orgScoped.push(t);
    else if (colNames.has("active_organization_id")) pointerTables.push(t.name);
  });
  const names = new Set(orgScoped.map((t) => t.name));
  const refs = new Map<string, string[]>();
  for (const t of orgScoped) {
    refs.set(
      t.name,
      [...(t.sql ?? "").matchAll(/REFERENCES\s+"?(\w+)"?/gi)]
        .map((m) => m[1])
        .filter((n) => names.has(n))
    );
  }
  const parentsFirst: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (n: string): void => {
    if (done.has(n) || visiting.has(n)) return;
    visiting.add(n);
    for (const ref of refs.get(n) ?? []) visit(ref);
    visiting.delete(n);
    done.add(n);
    parentsFirst.push(n);
  };
  for (const n of names) visit(n);

  const escaped = organizationId.replace(/'/g, "''");
  const deleted: Record<string, number> = {};
  // Children first: reverse of parents-first order.
  for (const name of parentsFirst.toReversed()) {
    const res = await db.run(
      sql.raw(`DELETE FROM "${name}" WHERE organization_id = '${escaped}'`)
    );
    deleted[name] = res.meta.changes ?? 0;
  }
  for (const name of pointerTables) {
    await db.run(
      sql.raw(
        `DELETE FROM "${name}" WHERE active_organization_id = '${escaped}'`
      )
    );
  }

  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  await stub.destroy();

  await db.delete(organization).where(eq(organization.id, organizationId));

  return { r2Objects: r2Keys.length, tables: deleted };
}

/**
 * GDPR-style customer deletion: scrubs the contact's PII and removes any
 * widget sessions (which carry email/externalId) while keeping ticket
 * history intact for the workspace.
 */
export async function anonymizeCustomer(
  db: D1Client,
  organizationId: string,
  customerId: string
): Promise<{ sessionsRemoved: number }> {
  await db
    .update(supportCustomers)
    .set({
      email: `deleted-${customerId}@redacted.local`,
      fullName: null,
      phone: null,
      externalId: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(supportCustomers.organizationId, organizationId),
        eq(supportCustomers.id, customerId)
      )
    );
  const removed = await db
    .delete(supportWidgetSessions)
    .where(
      and(
        eq(supportWidgetSessions.organizationId, organizationId),
        eq(supportWidgetSessions.customerId, customerId)
      )
    )
    .returning({ id: supportWidgetSessions.id });
  return { sessionsRemoved: removed.length };
}

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { WorkerEnv } from "../platform/middleware.js";
import { createD1 } from "./db.js";
import { deleteWorkspaceData } from "./deletion.js";
import { organization } from "./schema.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

describe("deleteWorkspaceData", () => {
  it("sweeps every org-scoped R2 prefix, not just row-tracked keys", async () => {
    const db = createD1(env.D1);
    const organizationId = `org-del-${crypto.randomUUID()}`;
    await db.insert(organization).values({
      id: organizationId,
      name: "R2 sweep test",
      slug: organizationId,
    });

    const keys = [
      `${organizationId}/files/note.txt`,
      `${organizationId}/capture/sess/log/console.log`,
      `attachments/${organizationId}/customer/c1/a1`,
      `artifacts/${organizationId}/session/s1/out.log`,
    ];
    for (const key of keys) await env.ATTACHMENTS_BUCKET.put(key, "x");
    // Objects belonging to other workspaces under the same prefix families
    // must survive the sweep.
    const foreign = [
      `attachments/org-other/customer/c1/a1`,
      `org-other/files/note.txt`,
      `artifacts/org-other/session/s1/out.log`,
    ];
    for (const key of foreign) await env.ATTACHMENTS_BUCKET.put(key, "x");

    const result = await deleteWorkspaceData(db, env, organizationId);

    expect(result.r2Objects).toBe(keys.length);
    for (const key of keys) {
      expect(await env.ATTACHMENTS_BUCKET.get(key)).toBeNull();
    }
    for (const key of foreign) {
      expect(await env.ATTACHMENTS_BUCKET.get(key)).not.toBeNull();
    }
    await env.ATTACHMENTS_BUCKET.delete(foreign);

    expect(
      await db
        .select()
        .from(organization)
        .where(eq(organization.id, organizationId))
        .get()
    ).toBeUndefined();
  });
});

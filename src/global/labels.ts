import { and, eq, inArray } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { labels } from "./schema.js";

export function findLabelsByWorkspaceAndNames(
  db: D1Client,
  organizationId: string,
  names: string[]
) {
  if (names.length === 0) {
    return Promise.resolve([]);
  }
  return db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.organizationId, organizationId),
        inArray(labels.name, names)
      )
    )
    .all();
}

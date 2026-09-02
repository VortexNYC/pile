import { eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { workspaceTokens } from "./schema.js";

export function findWorkspaceToken(db: D1Client, token: string) {
  return db
    .select()
    .from(workspaceTokens)
    .where(eq(workspaceTokens.tokenHash, token))
    .get();
}

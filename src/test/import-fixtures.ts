import { env } from "cloudflare:test";

import { createD1 } from "../global/db.js";
import { createImportJob } from "../global/import-jobs.js";
import { user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import { createImportContext } from "../import/runner.js";
import type { ImportContext } from "../import/types.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

interface IssueWriteCall {
  method: "createIssue" | "updateIssue";
  options: { notify?: boolean } | undefined;
}

type WorkspaceStub = ImportContext["stub"];

// Importers suppress directed notifications (the issue_assigned fan-out and
// its email) with `notify: false`; this records the flag on every issue write
// so a test can assert a bulk sync never emits a directed signal.
function spyIssueWrites(stub: WorkspaceStub): {
  stub: WorkspaceStub;
  calls: IssueWriteCall[];
} {
  const calls: IssueWriteCall[] = [];
  const proxied = new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "createIssue") {
        const original = Reflect.get(
          target,
          prop,
          receiver
        ) as WorkspaceStub["createIssue"];
        return (...args: Parameters<WorkspaceStub["createIssue"]>) => {
          calls.push({ method: "createIssue", options: args[2] });
          return original(...args);
        };
      }
      if (prop === "updateIssue") {
        const original = Reflect.get(
          target,
          prop,
          receiver
        ) as WorkspaceStub["updateIssue"];
        return (...args: Parameters<WorkspaceStub["updateIssue"]>) => {
          calls.push({ method: "updateIssue", options: args[3] });
          return original(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { stub: proxied, calls };
}

export async function seedImportContext(source: string): Promise<{
  ctx: ImportContext;
  issueWrites: IssueWriteCall[];
}> {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Test workspace",
    slug: `test-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  const organizationId = workspace!.id;
  await createDefaultTeam(db, env, headers, organizationId, "IMP", "user-1");
  const job = await createImportJob(db, organizationId, source, {});
  const ctx = await createImportContext(
    env,
    headers,
    organizationId,
    "user-1",
    job.id
  );
  const spy = spyIssueWrites(ctx.stub);
  ctx.stub = spy.stub;
  return { ctx, issueWrites: spy.calls };
}

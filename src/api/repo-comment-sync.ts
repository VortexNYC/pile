import { z } from "@hono/zod-openapi";

import { decryptSecret } from "../agents/credentials.js";
import type { D1Client } from "../global/db.js";
import { getInstallationToken } from "../global/github-auth.js";
import { findGithubInstallation } from "../global/github-installations.js";
import { gitlabFetch } from "../global/gitlab-auth.js";
import { findGitlabInstallation } from "../global/gitlab-installations.js";
import { findRepoIssueByIssueId } from "../global/repo-issues.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { Comment } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";

/** Push a Pile comment to the issue's GitHub/GitLab mirror and stamp the
 *  returned external id back on the comment. Shared by the comment POST
 *  path and the PILE-428 draft publish path so a published agent draft
 *  syncs exactly like the comment it would have been. Returns the
 *  updated comment, or null when the issue has no repo mapping (or the
 *  provider call didn't produce an external id). */
export async function syncCommentToRepoMapping(
  env: WorkerEnv,
  db: D1Client,
  stub: DurableObjectStub<WorkspaceDO>,
  issue: { id: string; organizationId: string },
  comment: { id: string; body: string }
): Promise<Comment | null> {
  const mapping = await findRepoIssueByIssueId(db, issue.id);
  if (!mapping) return null;

  if (mapping.source === "github") {
    const installation = await findGithubInstallation(db, mapping.repo);
    if (installation) {
      const token = await getInstallationToken(
        env,
        installation.installationId
      );
      if (token) {
        const response = await fetch(
          `https://api.github.com/repos/${mapping.repo}/issues/${mapping.issueNumber}/comments`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
              "User-Agent": "vortex",
            },
            body: JSON.stringify({ body: comment.body }),
          }
        );
        if (response.ok) {
          const raw: unknown = await response.json();
          const parsed = z.object({ id: z.number().int() }).safeParse(raw);
          if (parsed.success) {
            const updated = await stub.updateComment(comment.id, {
              body: comment.body,
              externalId: parsed.data.id.toString(),
              externalSource: "github",
            });
            if (updated) return updated;
          }
        }
      }
    }
  }

  if (mapping.source === "gitlab") {
    const installation = await findGitlabInstallation(
      db,
      issue.organizationId,
      mapping.repo
    );
    if (installation) {
      const response = await gitlabFetch(
        env,
        (await decryptSecret(env, installation.token)) ?? "",
        `/projects/${encodeURIComponent(mapping.repo)}/issues/${mapping.issueNumber}/notes`,
        {
          method: "POST",
          body: JSON.stringify({ body: comment.body }),
        }
      );
      if (response.ok) {
        const raw: unknown = await response.json();
        const parsed = z
          .object({ id: z.union([z.string(), z.number()]) })
          .safeParse(raw);
        if (parsed.success) {
          const updated = await stub.updateComment(comment.id, {
            body: comment.body,
            externalId: String(parsed.data.id),
            externalSource: "gitlab",
          });
          if (updated) return updated;
        }
      }
    }
  }

  return null;
}

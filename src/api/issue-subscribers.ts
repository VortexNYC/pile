import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { Issue } from "../types/workspace.js";
import { assertIssueAccess } from "./issue-access.js";
import { getWorkspaceStub } from "./stub.js";

const issueSubscriberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  linearUserId: z.string(),
  createdAt: z.string(),
});

const subscriberBodySchema = z.object({
  linearUserId: z.string().min(1),
});

const listIssueSubscribersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/subscribers",
  tags: ["issue-subscribers"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Issue subscribers list",
      content: {
        "application/json": {
          schema: z.object({ subscribers: z.array(issueSubscriberSchema) }),
        },
      },
    },
  },
});

const createIssueSubscriberRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/subscribers",
  tags: ["issue-subscribers"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    body: {
      content: { "application/json": { schema: subscriberBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Subscriber added",
      content: { "application/json": { schema: issueSubscriberSchema } },
    },
  },
});

const deleteIssueSubscriberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{issueId}/subscribers/{id}",
  tags: ["issue-subscribers"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Subscriber removed" },
  },
});

async function accessibleIssue(
  stub: ReturnType<typeof getWorkspaceStub>,
  db: ReturnType<typeof createD1>,
  issueRef: string,
  identity: WorkspaceIdentity
): Promise<Issue> {
  const issue = await stub.getIssue(issueRef);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  await assertIssueAccess(db, stub, issue, identity);
  return issue;
}

export function registerIssueSubscriberRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssueSubscribersRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await accessibleIssue(stub, db, issueId, identity);
    const items = await stub.listIssueSubscribers(issue.id);
    return c.json({ subscribers: items });
  });

  app.openapi(createIssueSubscriberRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await accessibleIssue(stub, db, issueId, identity);
    const item = await stub.createIssueSubscriber({
      issueId: issue.id,
      linearUserId: input.linearUserId,
    });
    return c.json(item, 201);
  });

  app.openapi(deleteIssueSubscriberRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getIssueSubscriber(id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Subscriber not found",
      });
    }
    await accessibleIssue(stub, db, existing.issueId, identity);
    await stub.deleteIssueSubscriber(id);
    return c.body(null, 204);
  });
}

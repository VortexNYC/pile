import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { getWorkspaceStub } from "./stub.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const approvalSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  requestedById: z.string(),
  approverId: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  comment: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

const createApprovalRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/approvals",
  tags: ["approvals"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            approverId: z.string(),
            comment: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Approval requested",
      content: { "application/json": { schema: approvalSchema } },
    },
  },
});

const listApprovalsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/approvals",
  tags: ["approvals"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Approvals for issue",
      content: {
        "application/json": {
          schema: z.object({ approvals: z.array(approvalSchema) }),
        },
      },
    },
  },
});

const respondApprovalRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/approvals/{id}/respond",
  tags: ["approvals"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["approved", "rejected"]),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Approval resolved",
      content: { "application/json": { schema: approvalSchema } },
    },
  },
});

export function registerApprovalRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createApprovalRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { approverId, comment } = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const item = await stub.createIssueApproval({
      issueId,
      requestedById: c.get("workspaceIdentity").id,
      approverId,
      comment,
    });
    return c.json(item, 201);
  });

  app.openapi(listApprovalsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const items = await stub.listIssueApprovals(issueId);
    return c.json({ approvals: items });
  });

  app.openapi(respondApprovalRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const item = await stub.getIssueApproval(id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Approval not found",
      });
    }
    const identity = c.get("workspaceIdentity");
    const isApprover = identity.id === item.approverId;
    const isAdmin = identity.permissions.includes("admin");
    if (!isApprover && !isAdmin) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only the approver or an admin can resolve this approval",
      });
    }
    const resolved = await stub.resolveIssueApproval(id, status);
    return c.json(resolved ?? item);
  });
}

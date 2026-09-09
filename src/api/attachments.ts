import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const attachmentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  linearId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  r2Key: z.string().nullable(),
  createdAt: z.string(),
});

const createAttachmentBodySchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
});

const listAttachmentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/attachments",
  tags: ["attachments"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Attachments list",
      content: {
        "application/json": {
          schema: z.object({ attachments: z.array(attachmentSchema) }),
        },
      },
    },
  },
});

const getAttachmentRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/attachments/{id}",
  tags: ["attachments"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Attachment",
      content: { "application/json": { schema: attachmentSchema } },
    },
    404: { description: "Attachment not found" },
  },
});

const createAttachmentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/attachments",
  tags: ["attachments"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    body: {
      content: { "application/json": { schema: createAttachmentBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Attachment created",
      content: { "application/json": { schema: attachmentSchema } },
    },
    404: { description: "Issue not found" },
  },
});

const deleteAttachmentRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{issueId}/attachments/{id}",
  tags: ["attachments"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Attachment deleted" },
    404: { description: "Attachment not found" },
  },
});

function toAttachmentResponse(row: z.infer<typeof attachmentSchema>) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    issueId: row.issueId,
    linearId: row.linearId,
    url: row.url,
    title: row.title,
    subtitle: row.subtitle,
    r2Key: row.r2Key,
    createdAt: row.createdAt,
  };
}

export function registerAttachmentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listAttachmentsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const items = await stub.listAttachments(issueId);
    return c.json({ attachments: items.map(toAttachmentResponse) });
  });

  app.openapi(getAttachmentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Attachment not found",
      });
    }
    const item = await stub.getAttachment(id);
    if (!item || item.issueId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Attachment not found",
      });
    }
    return c.json(toAttachmentResponse(item));
  });

  app.openapi(createAttachmentRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot attach to this issue",
      });
    }
    const item = await stub.createAttachment({
      issueId,
      linearId: "",
      url: input.url,
      title: input.title ?? null,
      subtitle: input.subtitle ?? null,
      r2Key: null,
    });
    return c.json(toAttachmentResponse(item!), 201);
  });

  app.openapi(deleteAttachmentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Attachment not found",
      });
    }
    const item = await stub.getAttachment(id);
    if (!item || item.issueId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Attachment not found",
      });
    }
    await stub.deleteAttachment(id);
    return c.body(null, 204);
  });
}

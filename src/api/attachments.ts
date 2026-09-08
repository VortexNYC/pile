import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { getWorkspaceStub } from "./stub.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

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

export function registerAttachmentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listAttachmentsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const items = await stub.listAttachments(issueId);
    return c.json({ attachments: items });
  });
}

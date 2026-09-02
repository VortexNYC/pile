import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { listAttachments } from "../global/attachments.js";
import { createD1 } from "../global/db.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const attachmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
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
  path: "/workspaces/{workspaceId}/issues/{issueId}/attachments",
  tags: ["attachments"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
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
    const { workspaceId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listAttachments(db, workspaceId, issueId);
    return c.json({ attachments: items });
  });
}

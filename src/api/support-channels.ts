import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import {
  intercomSupportWebhookRoute,
  processIntercomSupportWebhook,
} from "../channels/intercom.js";
import {
  plainSupportWebhookRoute,
  processPlainSupportWebhook,
} from "../channels/plain.js";
import {
  zendeskSupportWebhookRoute,
  processZendeskSupportWebhook,
} from "../channels/zendesk.js";
import { createD1 } from "../global/db.js";
import { supportChannels } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const supportChannelSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.enum([
    "email",
    "slack",
    "msteams",
    "discord",
    "chat",
    "capture",
    "api",
    "intercom",
    "zendesk",
    "plain",
  ]),
  name: z.string(),
  isActive: z.boolean(),
  config: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createSupportChannelSchema = z.object({
  type: supportChannelSchema.shape.type,
  name: z.string().min(1).max(200),
  config: z.record(z.unknown()).optional(),
  isActive: z.boolean().default(true),
});

const supportChannelParamsSchema = z.object({
  organizationId: z.string(),
});

export function registerSupportChannelRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{organizationId}/support-channels",
      tags: ["support-channels"],
      middleware: [rls("read")],
      request: { params: supportChannelParamsSchema },
      responses: {
        200: {
          description: "Support channels list",
          content: {
            "application/json": {
              schema: z.object({ channels: z.array(supportChannelSchema) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { organizationId } = c.req.valid("param");
      const db = createD1(c.env.D1);
      const rows = await db
        .select()
        .from(supportChannels)
        .where(eq(supportChannels.organizationId, organizationId))
        .all();
      return c.json({
        channels: rows.map((row) => ({
          id: row.id,
          organizationId: row.organizationId,
          type: row.type,
          name: row.name,
          isActive: row.isActive,
          config: JSON.parse(row.config),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      });
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/workspaces/{organizationId}/support-channels",
      tags: ["support-channels"],
      middleware: [rls("admin")],
      request: {
        params: supportChannelParamsSchema,
        body: {
          content: {
            "application/json": { schema: createSupportChannelSchema },
          },
        },
      },
      responses: {
        201: {
          description: "Support channel created",
          content: { "application/json": { schema: supportChannelSchema } },
        },
      },
    }),
    async (c) => {
      const { organizationId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createD1(c.env.D1);

      const existing = await db
        .select()
        .from(supportChannels)
        .where(
          and(
            eq(supportChannels.organizationId, organizationId),
            eq(supportChannels.type, input.type),
            eq(supportChannels.name, input.name.toLowerCase().trim())
          )
        )
        .limit(1);
      if (existing.length > 0) {
        throw new VortexError({
          code: "CONFLICT",
          status: 409,
          message: "Support channel already exists",
        });
      }

      const id = crypto.randomUUID();
      const ts = new Date().toISOString();
      const config = JSON.stringify(input.config ?? {});
      await db.insert(supportChannels).values({
        id,
        organizationId,
        type: input.type,
        name: input.name.toLowerCase().trim(),
        isActive: input.isActive,
        config,
        createdAt: ts,
        updatedAt: ts,
      });
      return c.json(
        {
          id,
          organizationId,
          type: input.type,
          name: input.name,
          isActive: input.isActive,
          config: input.config ?? {},
          createdAt: ts,
          updatedAt: ts,
        },
        201
      );
    }
  );

  app.openapi(intercomSupportWebhookRoute, async (c) =>
    c.json(await processIntercomSupportWebhook(c))
  );

  app.openapi(zendeskSupportWebhookRoute, async (c) =>
    c.json(await processZendeskSupportWebhook(c))
  );

  app.openapi(plainSupportWebhookRoute, async (c) =>
    c.json(await processPlainSupportWebhook(c))
  );
}

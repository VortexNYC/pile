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
  slackSupportWebhookRoute,
  processSlackSupportWebhook,
} from "../channels/slack.js";
import {
  zendeskSupportWebhookRoute,
  processZendeskSupportWebhook,
} from "../channels/zendesk.js";
import { createD1 } from "../global/db.js";
import { supportChannels } from "../global/schema.js";
import {
  processIncomingMessage,
  processOutgoingMessage,
  validateSupportChannel,
} from "../global/support-channels.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const supportChannelTypeEnum = z.enum([
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
]);

const baseMessagingConfig = z.object({
  channelId: z.string().optional(),
  webhookUrl: z.string().optional(),
  color: z.string().optional(),
});

const slackMessagingConfig = baseMessagingConfig.extend({
  botToken: z.string().optional(),
});

const supportChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      emailAddress: z.string().optional(),
      color: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("slack"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: slackMessagingConfig,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("msteams"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: baseMessagingConfig,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("discord"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: baseMessagingConfig,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("chat"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      widgetId: z.string().optional(),
      color: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("capture"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      formId: z.string().optional(),
      color: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("api"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({ endpoint: z.string().optional() }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("intercom"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      appId: z.string().optional(),
      accessToken: z.string().optional(),
      adminId: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("zendesk"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      subdomain: z.string().optional(),
      accessToken: z.string().optional(),
      email: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("plain"),
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    config: z.object({
      workspaceId: z.string().optional(),
      accessToken: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
]);

const createSupportChannelSchema = z.object({
  type: supportChannelTypeEnum,
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.string()).optional(),
  isActive: z.boolean().default(true),
});

const supportChannelParamsSchema = z.object({
  organizationId: z.string(),
});

const channelIdParamSchema = z.object({
  channelId: z.string(),
});

const incomingMessageSchema = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string().default(""),
  text: z.string(),
  html: z.string().optional(),
  externalTicketId: z.string().optional(),
  externalMessageId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
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
        channels: rows.map((row) =>
          supportChannelSchema.parse({
            ...row,
            config: JSON.parse(row.config),
          })
        ),
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
      const response = supportChannelSchema.parse({
        type: input.type,
        id,
        organizationId,
        name: input.name,
        isActive: input.isActive,
        config: input.config ?? {},
        createdAt: ts,
        updatedAt: ts,
      });
      return c.json(response, 201);
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

  app.openapi(slackSupportWebhookRoute, async (c) =>
    c.json(await processSlackSupportWebhook(c))
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/support/incoming/{channelId}",
      tags: ["support-channels"],
      summary: "Receive a generic incoming support message",
      middleware: [],
      request: {
        params: channelIdParamSchema,
        body: {
          content: {
            "application/json": { schema: incomingMessageSchema },
          },
        },
      },
      responses: {
        201: {
          description: "Message processed",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                ticketId: z.string(),
                ticketNumber: z.number(),
              }),
            },
          },
        },
        404: { description: "Channel not found or inactive" },
      },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createD1(c.env.D1);
      const [channel] = await db
        .select()
        .from(supportChannels)
        .where(
          and(
            eq(supportChannels.id, channelId),
            eq(supportChannels.isActive, true)
          )
        )
        .limit(1);

      if (!channel) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Channel not found or inactive",
        });
      }

      const channelType = supportChannelTypeEnum.parse(channel.type);

      const ticket = await processIncomingMessage(
        db,
        channel.organizationId,
        {
          channel: channelType,
          externalSource: channelType,
          fromEmail: input.fromEmail,
          fromName: input.fromName ?? null,
          subject: input.subject,
          text: input.text,
          html: input.html ?? null,
          externalTicketId: input.externalTicketId ?? null,
          externalMessageId: input.externalMessageId ?? null,
          createdAt: input.createdAt,
        },
        c.env
      );

      return c.json(
        { ok: true, ticketId: ticket.id, ticketNumber: ticket.number },
        201
      );
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/workspaces/{organizationId}/support/channels/{channelId}/send",
      tags: ["support-channels"],
      summary: "Send an outbound support message",
      middleware: [rls("write")],
      request: {
        params: z.object({
          organizationId: z.string(),
          channelId: z.string(),
        }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                ticketId: z.string(),
                textContent: z.string(),
                markdownContent: z.string().optional(),
                subject: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Message sent",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                messageId: z.string(),
                sent: z.boolean(),
              }),
            },
          },
        },
        400: { description: "Bad request" },
        404: { description: "Ticket, customer, or channel not found" },
      },
    }),
    async (c) => {
      const { organizationId, channelId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createD1(c.env.D1);
      const [channel] = await db
        .select()
        .from(supportChannels)
        .where(
          and(
            eq(supportChannels.id, channelId),
            eq(supportChannels.organizationId, organizationId),
            eq(supportChannels.isActive, true)
          )
        )
        .limit(1);

      if (!channel) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Channel not found or inactive",
        });
      }

      const result = await processOutgoingMessage(
        db,
        c.env,
        channel,
        input,
        c.var.workspaceIdentity.id
      );

      return c.json(result, 200);
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/workspaces/{organizationId}/support/channels/{channelId}/validate",
      tags: ["support-channels"],
      summary: "Validate a support channel",
      middleware: [rls("read")],
      request: {
        params: z.object({
          organizationId: z.string(),
          channelId: z.string(),
        }),
      },
      responses: {
        200: {
          description: "Validation result",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                message: z.string().optional(),
              }),
            },
          },
        },
        404: { description: "Channel not found or inactive" },
      },
    }),
    async (c) => {
      const { organizationId, channelId } = c.req.valid("param");
      const db = createD1(c.env.D1);
      const [channel] = await db
        .select()
        .from(supportChannels)
        .where(
          and(
            eq(supportChannels.id, channelId),
            eq(supportChannels.organizationId, organizationId),
            eq(supportChannels.isActive, true)
          )
        )
        .limit(1);

      if (!channel) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Channel not found or inactive",
        });
      }

      const result = await validateSupportChannel(db, c.env, channel);
      return c.json(result, 200);
    }
  );
}

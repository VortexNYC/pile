import { createRoute } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { organization as organizationTable } from "../global/schema.js";
import {
  handleInboundSms,
  deliverSmsReply,
  resolveSmsOrganization,
} from "../global/support-sms.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getExecutionCtx } from "./execution-ctx.js";
export function registerSupportSmsRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/support/sms/inbound",
      tags: ["support-sms"],
      middleware: [],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                from_number: z.string().min(4),
                to_number: z.string().optional(),
                content: z.string().max(10_000).optional(),
                media_url: z.string().optional(),
                service: z.string().optional(),
                date_sent: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        202: { description: "Accepted" },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      if (!body.content || !body.content.trim()) {
        return c.body(null, 202);
      }
      const db = createD1(c.env.D1);
      const organizationId = await resolveSmsOrganization(
        db,
        body.to_number,
        c.env as unknown as Parameters<typeof resolveSmsOrganization>[2]
      );
      if (!organizationId) {
        // Unknown number — accept silently; Sendblue retries on 5xx and
        // a 4xx teaches a sender the tenant map.
        return c.body(null, 202);
      }
      const work = handleInboundSms(db, c.env as never, {
        organizationId,
        fromNumber: body.from_number,
        body: body.content,
      }).catch((err) => {
        console.error("sms inbound failed", {
          from: body.from_number,
          organizationId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      const ctx = getExecutionCtx(c);
      if (ctx) {
        ctx.waitUntil(work);
      } else {
        await work;
      }
      return c.body(null, 202);
    }
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{organizationId}/support/sms/status",
      tags: ["support-sms"],
      middleware: [rls("ticket:view")],
      request: {
        params: z.object({ organizationId: z.string() }),
      },
      responses: {
        200: {
          description: "SMS intake status",
          content: {
            "application/json": {
              schema: z.object({
                enabled: z.boolean(),
                number: z.string().nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { organizationId } = c.req.valid("param");
      const env = c.env as unknown as {
        SENDBLUE_FROM_NUMBER?: string;
        SMS_ORGANIZATION_ID?: string;
      };
      const db = createD1(c.env.D1);
      const [org] = await db
        .select({ metadata: organizationTable.metadata })
        .from(organizationTable)
        .where(eq(organizationTable.id, organizationId))
        .limit(1);
      let number: string | null = null;
      try {
        const meta = org?.metadata ? JSON.parse(org.metadata) : {};
        if (typeof meta.smsNumber === "string") number = meta.smsNumber;
      } catch {
        number = null;
      }
      number = number ?? env.SENDBLUE_FROM_NUMBER ?? null;
      const enabled = Boolean(
        number &&
        (env.SMS_ORGANIZATION_ID === organizationId ||
          (org?.metadata ?? "").includes("smsNumber"))
      );
      return c.json({ enabled, number });
    }
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/workspaces/{organizationId}/support/sms/threads/{threadId}/reply",
      tags: ["support-sms"],
      middleware: [rls("ticket:create")],
      request: {
        params: z.object({
          organizationId: z.string(),
          threadId: z.string(),
        }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ body: z.string().min(1).max(10_000) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Reply delivered",
          content: {
            "application/json": {
              schema: z.object({ delivered: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { organizationId, threadId } = c.req.valid("param");
      const { body } = c.req.valid("json");
      const db = createD1(c.env.D1);
      await deliverSmsReply(db, c.env as never, {
        organizationId,
        threadId,
        body,
      });
      return c.json({ delivered: true });
    }
  );
}

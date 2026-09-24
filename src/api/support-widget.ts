import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import chatWidgetBundle from "../assets/chat.iife.js";
import { createD1, type D1Client } from "../global/db.js";
import {
  createCustomer,
  findCustomerByExternalId,
  findOrCreateCustomerByEmail,
  getCustomerById,
} from "../global/support-contacts.js";
import {
  addTicketMessage,
  createTicket,
  listTicketEvents,
} from "../global/support-tickets.js";
import {
  createWidgetKey,
  createWidgetSession,
  findWidgetKeyByKey,
  findWidgetSessionByToken,
  listWidgetKeys,
  revokeWidgetKey,
  updateWidgetSession,
  verifyWidgetIdentityHash,
  type SupportWidgetKey,
  type SupportWidgetSession,
} from "../global/support-widget.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const widgetKeySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  key: z.string(),
  hmacSecret: z.string(),
  name: z.string(),
  allowedOrigins: z.array(z.string()),
  greeting: z.string().nullable(),
  brandColor: z.string().nullable(),
  requireEmail: z.boolean(),
  requireChallenge: z.boolean(),
  isActive: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createWidgetKeyBodySchema = z.object({
  name: z.string().min(1).default("Chat widget"),
  allowedOrigins: z.array(z.string()).default([]),
  greeting: z.string().nullable().optional(),
  brandColor: z.string().nullable().optional(),
  requireEmail: z.boolean().default(false),
  requireChallenge: z.boolean().default(false),
});

const createWidgetKeyRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/widget-keys",
  tags: ["support-widget"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createWidgetKeyBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Widget key created",
      content: {
        "application/json": { schema: widgetKeySchema },
      },
    },
  },
});

const listWidgetKeysRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/widget-keys",
  tags: ["support-widget"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Widget keys",
      content: {
        "application/json": {
          schema: z.object({ widgetKeys: z.array(widgetKeySchema) }),
        },
      },
    },
  },
});

const revokeWidgetKeyRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/widget-keys/{keyId}",
  tags: ["support-widget"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), keyId: z.string() }),
  },
  responses: {
    200: {
      description: "Widget key revoked",
      content: {
        "application/json": { schema: widgetKeySchema },
      },
    },
    404: { description: "Not found" },
  },
});

const widgetSessionResponseSchema = z.object({
  sessionToken: z.string(),
  ticketId: z.string().nullable(),
  identityVerified: z.boolean(),
  config: z.object({
    greeting: z.string().nullable(),
    brandColor: z.string().nullable(),
    requireEmail: z.boolean(),
  }),
  customer: z
    .object({
      email: z.string().nullable(),
      fullName: z.string().nullable(),
    })
    .nullable(),
});

const widgetSessionBodySchema = z.object({
  sessionToken: z.string().optional(),
  externalId: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
  identifierHash: z.string().optional(),
  turnstileToken: z.string().optional(),
});

const widgetSessionRoute = createRoute({
  method: "post",
  path: "/support/widget/{key}/session",
  tags: ["support-widget"],
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": { schema: widgetSessionBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Widget session created or resumed",
      content: {
        "application/json": { schema: widgetSessionResponseSchema },
      },
    },
  },
});

const widgetMessageBodySchema = z.object({
  text: z.string().min(1),
  externalId: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

const widgetMessageRoute = createRoute({
  method: "post",
  path: "/support/widget/{key}/messages",
  tags: ["support-widget"],
  request: {
    params: z.object({ key: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
    body: {
      content: {
        "application/json": { schema: widgetMessageBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Message appended",
      content: {
        "application/json": {
          schema: z.object({
            messageId: z.string(),
            ticketId: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
  },
});

const widgetMessagesRoute = createRoute({
  method: "get",
  path: "/support/widget/{key}/messages",
  tags: ["support-widget"],
  request: {
    params: z.object({ key: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
    query: z.object({ after: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Messages for the session's conversation",
      content: {
        "application/json": {
          schema: z.object({
            messages: z.array(
              z.object({
                id: z.string(),
                direction: z.enum(["inbound", "outbound"]),
                text: z.string(),
                createdAt: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

async function verifyTurnstile(
  secretKey: string,
  token: string,
  remoteIp: string | undefined
): Promise<boolean> {
  const form = new URLSearchParams({
    secret: secretKey,
    response: token,
    ...(remoteIp ? { remoteip: remoteIp } : {}),
  });
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  );
  if (!res.ok) return false;
  const payload = (await res.json()) as { success?: boolean };
  return payload.success === true;
}

function assertOriginAllowed(
  widgetKey: SupportWidgetKey,
  origin: string | undefined
) {
  if (widgetKey.allowedOrigins.length === 0) return;
  // Browsers always send Origin on cross-origin requests, so an Origin that is
  // present must match the allowlist. A missing Origin means a non-browser
  // client (curl, MCP, an agent) — the allowlist governs website embedding,
  // not API clients, so those are allowed through.
  if (!origin) return;
  if (!widgetKey.allowedOrigins.includes(origin)) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Origin not allowed",
    });
  }
}

async function requireWidgetKey(
  db: D1Client,
  key: string,
  origin: string | undefined
): Promise<SupportWidgetKey> {
  const widgetKey = await findWidgetKeyByKey(db, key);
  if (!widgetKey || !widgetKey.isActive) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Widget not found",
    });
  }
  assertOriginAllowed(widgetKey, origin);
  return widgetKey;
}

async function requireWidgetSession(
  db: D1Client,
  widgetKey: SupportWidgetKey,
  sessionToken: string
): Promise<SupportWidgetSession> {
  const session = await findWidgetSessionByToken(db, sessionToken);
  if (!session || session.widgetKeyId !== widgetKey.id) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Invalid or expired widget session",
    });
  }
  return session;
}

async function resolveWidgetCustomer(
  db: D1Client,
  widgetKey: SupportWidgetKey,
  input: {
    externalId?: string;
    email?: string;
    name?: string;
    identityVerified: boolean;
  }
) {
  const organizationId = widgetKey.organizationId;
  // Verified identity dedupes on (org, externalId, source) — the same verified
  // visitor resumes the same contact across browsers (Chatwoot model).
  if (input.identityVerified && input.externalId) {
    const existing = await findCustomerByExternalId(
      db,
      organizationId,
      input.externalId,
      "chat"
    );
    if (existing) return existing;
    return createCustomer(db, {
      organizationId,
      email: input.email ?? `widget-${input.externalId}@widget.pile`,
      fullName: input.name ?? null,
      externalId: input.externalId,
      externalSource: "chat",
    });
  }
  if (input.email) {
    return findOrCreateCustomerByEmail(
      db,
      organizationId,
      input.email,
      input.name ?? null,
      "chat"
    );
  }
  return null;
}

export function registerSupportWidgetRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createWidgetKeyRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const identity = c.get("workspaceIdentity");
    const widgetKey = await createWidgetKey(db, organizationId, {
      name: body.name,
      allowedOrigins: body.allowedOrigins,
      greeting: body.greeting ?? null,
      brandColor: body.brandColor ?? null,
      requireEmail: body.requireEmail,
      requireChallenge: body.requireChallenge,
      createdBy: identity?.id ?? null,
    });
    return c.json(widgetKeySchema.parse(widgetKey), 201);
  });

  app.openapi(listWidgetKeysRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const keys = await listWidgetKeys(db, organizationId);
    return c.json({ widgetKeys: keys.map((k) => widgetKeySchema.parse(k)) });
  });

  app.openapi(revokeWidgetKeyRoute, async (c) => {
    const { organizationId, keyId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const widgetKey = await revokeWidgetKey(db, organizationId, keyId);
    if (!widgetKey) {
      throw new VortexError({
        status: 404,
        code: "NOT_FOUND",
        message: "Widget key not found",
      });
    }
    return c.json(widgetKeySchema.parse(widgetKey));
  });

  // Public widget protocol — the wgt_ key is the credential; identity is the
  // anonymous → soft claims → verified identifierHash ladder.
  app.openapi(widgetSessionRoute, async (c) => {
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));

    // Resume: a stored session token is sufficient — no re-verification.
    if (body.sessionToken) {
      const session = await findWidgetSessionByToken(db, body.sessionToken);
      if (session && session.widgetKeyId === widgetKey.id) {
        const customer = session.customerId
          ? await getCustomerById(
              db,
              widgetKey.organizationId,
              session.customerId
            )
          : null;
        return c.json(
          widgetSessionResponseSchema.parse({
            sessionToken: session.token,
            ticketId: session.ticketId,
            identityVerified: session.identityVerified,
            config: {
              greeting: widgetKey.greeting,
              brandColor: widgetKey.brandColor,
              requireEmail: widgetKey.requireEmail,
            },
            customer: customer
              ? { email: customer.email, fullName: customer.fullName }
              : null,
          })
        );
      }
    }

    if (widgetKey.requireChallenge && c.env.TURNSTILE_SECRET_KEY) {
      const ok = body.turnstileToken
        ? await verifyTurnstile(
            c.env.TURNSTILE_SECRET_KEY,
            body.turnstileToken,
            c.req.header("cf-connecting-ip")
          )
        : false;
      if (!ok) {
        throw new VortexError({
          status: 403,
          code: "WIDGET_CHALLENGE_REQUIRED",
          message: "A Turnstile token is required",
        });
      }
    }

    if (widgetKey.requireEmail && !body.email && !body.externalId) {
      throw new VortexError({
        status: 400,
        code: "BAD_REQUEST",
        message: "Email is required to start a chat",
      });
    }

    let identityVerified = false;
    if (body.identifierHash) {
      const identifier = body.externalId ?? body.email;
      if (identifier) {
        identityVerified = await verifyWidgetIdentityHash(
          widgetKey,
          identifier,
          body.identifierHash
        );
      }
    }

    const customer = await resolveWidgetCustomer(db, widgetKey, {
      externalId: body.externalId,
      email: body.email,
      name: body.name,
      identityVerified,
    });

    const session = await createWidgetSession(db, widgetKey.organizationId, {
      widgetKeyId: widgetKey.id,
      customerId: customer?.id ?? null,
      externalId: body.externalId ?? null,
      identityVerified,
    });

    return c.json(
      widgetSessionResponseSchema.parse({
        sessionToken: session.token,
        ticketId: null,
        identityVerified,
        config: {
          greeting: widgetKey.greeting,
          brandColor: widgetKey.brandColor,
          requireEmail: widgetKey.requireEmail,
        },
        customer: customer
          ? { email: customer.email, fullName: customer.fullName }
          : null,
      })
    );
  });

  app.openapi(widgetMessageRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);

    // Late identity upgrade — the visitor can supply email/name with their
    // first message (the requireEmail-upfront form) instead of at boot.
    let customerId = session.customerId;
    if (!customerId) {
      const customer = await resolveWidgetCustomer(db, widgetKey, {
        externalId: session.externalId ?? undefined,
        email: body.email,
        name: body.name,
        identityVerified: session.identityVerified,
      });
      if (customer) {
        customerId = customer.id;
      } else {
        const anonymous = await createCustomer(db, {
          organizationId: widgetKey.organizationId,
          email: `anonymous-${session.id}@widget.pile`,
          externalSource: "chat",
        });
        customerId = anonymous.id;
      }
    }

    let ticketId = session.ticketId;
    if (!ticketId) {
      const title =
        body.text.length > 80 ? `${body.text.slice(0, 77)}…` : body.text;
      const ticket = await createTicket(
        db,
        {
          organizationId: widgetKey.organizationId,
          customerId,
          title,
          sourceChannel: "chat",
          externalSource: "chat",
          externalId: `widget-session:${session.id}`,
          ifExists: "return",
        },
        c.env as WorkerEnv
      );
      ticketId = ticket.id;
    }

    const message = await addTicketMessage(
      db,
      widgetKey.organizationId,
      ticketId,
      {
        direction: "inbound",
        textContent: body.text,
        channel: "chat",
        customerId,
        actorType: "customer",
        actorId: customerId,
        externalId: body.externalId ?? null,
      },
      c.env as WorkerEnv
    );

    if (customerId !== session.customerId || ticketId !== session.ticketId) {
      await updateWidgetSession(db, session.id, { customerId, ticketId });
    }

    return c.json({
      messageId: message.id,
      ticketId,
      createdAt: message.createdAt,
    });
  });

  app.openapi(widgetMessagesRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const { after } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);

    if (!session.ticketId) {
      return c.json({ messages: [] });
    }

    const events = await listTicketEvents(
      db,
      widgetKey.organizationId,
      session.ticketId,
      { limit: 100, cursor: after }
    );

    const messages = events
      .filter((e) => e.type === "message" && e.message)
      .map((e) => ({
        id: e.id,
        direction: e.message!.direction as "inbound" | "outbound",
        text: e.message!.textContent,
        createdAt: e.createdAt,
      }));

    return c.json({ messages });
  });

  // The widget bundle — the one-tag embed:
  // <script src="https://pile.nyc/chat.js" data-pile-widget="wgt_…">
  app.get("/chat.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    c.header("access-control-allow-origin", "*");
    return c.body(chatWidgetBundle);
  });
}

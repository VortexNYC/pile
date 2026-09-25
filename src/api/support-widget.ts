import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";

import chatWidgetBundle from "../assets/chat.iife.js";
import { listChangelogEntries } from "../global/changelog.js";
import { createD1, type D1Client } from "../global/db.js";
import { supportTicketVotes } from "../global/schema.js";
import {
  createCustomer,
  findCustomerByExternalId,
  findOrCreateCustomerByEmail,
  getCustomerById,
} from "../global/support-contacts.js";
import {
  addTicketMessage,
  addTicketVote,
  createTicket,
  getTicketById,
  listPublicBoard,
  listTicketEvents,
  listTicketVotes,
  removeTicketVote,
  updateTicket,
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
import { publicRateLimit } from "../platform/rate-limit.js";
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
  middleware: [publicRateLimit({ bucket: "widget-session", max: 20 })],
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
  middleware: [publicRateLimit({ bucket: "widget-message", max: 60 })],
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
  middleware: [publicRateLimit({ bucket: "widget-poll", max: 120 })],
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

const widgetVoteBodySchema = z.object({
  ticketId: z.string().min(1),
  priority: z.enum(["nice_to_have", "important", "must_have"]).optional(),
});

const widgetVoteRoute = createRoute({
  method: "post",
  path: "/support/widget/{key}/votes",
  tags: ["support-widget"],
  middleware: [publicRateLimit({ bucket: "widget-vote", max: 30 })],
  request: {
    params: z.object({ key: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
    body: {
      content: { "application/json": { schema: widgetVoteBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Vote recorded (idempotent per ticket + session customer)",
      content: {
        "application/json": {
          schema: z.object({
            created: z.boolean(),
            voteCount: z.number(),
          }),
        },
      },
    },
  },
});

const widgetUnvoteRoute = createRoute({
  method: "delete",
  path: "/support/widget/{key}/votes/{ticketId}",
  tags: ["support-widget"],
  middleware: [publicRateLimit({ bucket: "widget-vote", max: 30 })],
  request: {
    params: z.object({ key: z.string(), ticketId: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
  },
  responses: {
    200: {
      description: "Vote removed",
      content: {
        "application/json": {
          schema: z.object({ removed: z.boolean(), voteCount: z.number() }),
        },
      },
    },
  },
});

const widgetBoardItemSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  voteCount: z.number(),
  voted: z.boolean(),
  createdAt: z.string(),
});

const widgetBoardRoute = createRoute({
  method: "get",
  path: "/support/widget/{key}/board",
  tags: ["support-widget"],
  middleware: [publicRateLimit({ bucket: "widget-poll", max: 120 })],
  request: {
    params: z.object({ key: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
  },
  responses: {
    200: {
      description: "Public board items with the session customer's vote flags",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(widgetBoardItemSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const widgetChangelogRoute = createRoute({
  method: "get",
  path: "/support/widget/{key}/changelog",
  tags: ["support-widget"],
  middleware: [publicRateLimit({ bucket: "widget-poll", max: 120 })],
  request: {
    params: z.object({ key: z.string() }),
  },
  responses: {
    200: {
      description: "Published changelog entries for the workspace",
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                body: z.string(),
                labels: z.array(z.string()),
                publishedAt: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

const widgetIdeaBodySchema = z.object({
  title: z.string().min(3).max(200),
  text: z.string().max(5000).optional(),
});

const widgetIdeaRoute = createRoute({
  method: "post",
  path: "/support/widget/{key}/ideas",
  tags: ["support-widget"],
  middleware: [publicRateLimit({ bucket: "widget-idea", max: 10 })],
  request: {
    params: z.object({ key: z.string() }),
    headers: z.object({ "x-pile-widget-session": z.string() }),
    body: {
      content: { "application/json": { schema: widgetIdeaBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Public idea ticket created and auto-voted by the author",
      content: {
        "application/json": {
          schema: z.object({ ticketId: z.string(), voteCount: z.number() }),
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

async function requireSessionCustomer(
  db: D1Client,
  widgetKey: SupportWidgetKey,
  session: SupportWidgetSession
) {
  if (!session.customerId) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "An identified session is required to vote",
    });
  }
  const customer = await getCustomerById(
    db,
    widgetKey.organizationId,
    session.customerId
  );
  if (!customer) {
    throw new VortexError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "An identified session is required to vote",
    });
  }
  return customer;
}

async function requirePublicTicket(
  db: D1Client,
  widgetKey: SupportWidgetKey,
  ticketId: string
) {
  const ticket = await getTicketById(db, widgetKey.organizationId, ticketId);
  if (!ticket || !ticket.isPublic) {
    throw new VortexError({
      status: 404,
      code: "NOT_FOUND",
      message: "Ticket not found",
    });
  }
  return ticket;
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
      let session = await findWidgetSessionByToken(db, body.sessionToken);
      if (session && session.widgetKeyId === widgetKey.id) {
        // Late identity upgrade — an anonymous session that later supplies
        // email/externalId (+identifierHash) adopts that customer so votes
        // and ideas attribute correctly.
        if (!session.customerId && (body.email ?? body.externalId)) {
          let upgradedVerified = session.identityVerified;
          if (body.identifierHash) {
            const identifier = body.externalId ?? body.email;
            if (identifier) {
              upgradedVerified = await verifyWidgetIdentityHash(
                widgetKey,
                identifier,
                body.identifierHash
              );
            }
          }
          const resolved = await resolveWidgetCustomer(db, widgetKey, {
            externalId: body.externalId,
            email: body.email,
            name: body.name,
            identityVerified: upgradedVerified,
          });
          if (resolved) {
            await updateWidgetSession(db, session.id, {
              customerId: resolved.id,
              externalId: body.externalId ?? session.externalId,
              identityVerified: upgradedVerified,
            });
            session = {
              ...session,
              customerId: resolved.id,
              identityVerified: upgradedVerified,
            };
          }
        }
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

  // Voting through the widget session — the customer's email comes from the
  // verified session, never from the request body, so identity is the
  // anonymous → soft-claims → identifierHash ladder all the way down.
  app.openapi(widgetVoteRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);
    const customer = await requireSessionCustomer(db, widgetKey, session);
    const ticket = await requirePublicTicket(db, widgetKey, body.ticketId);

    const { created } = await addTicketVote(
      db,
      widgetKey.organizationId,
      ticket.id,
      {
        voterEmail: customer.email,
        customerId: customer.id,
        priority: body.priority,
        castByActorType: "customer",
        castByActorId: customer.id,
      }
    );
    const votes = await listTicketVotes(
      db,
      widgetKey.organizationId,
      ticket.id
    );
    return c.json({ created, voteCount: votes.length }, 200);
  });

  app.openapi(widgetUnvoteRoute, async (c) => {
    const { key, ticketId } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);
    const customer = await requireSessionCustomer(db, widgetKey, session);
    const ticket = await requirePublicTicket(db, widgetKey, ticketId);

    const removed = await removeTicketVote(
      db,
      widgetKey.organizationId,
      ticket.id,
      { email: customer.email }
    );
    const votes = await listTicketVotes(
      db,
      widgetKey.organizationId,
      ticket.id
    );
    return c.json({ removed, voteCount: votes.length }, 200);
  });

  // Board/changelog/ideas — the Ideas tab surfaces. Board items carry a
  // per-session `voted` flag so the widget renders the toggle correctly.
  app.openapi(widgetBoardRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);

    const { items, nextCursor } = await listPublicBoard(
      db,
      widgetKey.organizationId,
      { limit: 100 }
    );

    let votedIds = new Set<string>();
    const customer = session.customerId
      ? await getCustomerById(db, widgetKey.organizationId, session.customerId)
      : null;
    if (customer && items.length > 0) {
      const rows = await db
        .select({ ticketId: supportTicketVotes.ticketId })
        .from(supportTicketVotes)
        .where(
          and(
            eq(supportTicketVotes.organizationId, widgetKey.organizationId),
            eq(supportTicketVotes.voterEmail, customer.email),
            inArray(
              supportTicketVotes.ticketId,
              items.map((i) => i.id)
            )
          )
        );
      votedIds = new Set(rows.map((r) => r.ticketId));
    }

    const flagged = items.map((i) =>
      Object.assign(i, { voted: votedIds.has(i.id) })
    );
    return c.json({ items: flagged, nextCursor }, 200);
  });

  app.openapi(widgetChangelogRoute, async (c) => {
    const { key } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const { entries } = await listChangelogEntries(
      db,
      widgetKey.organizationId,
      { publishedOnly: true, limit: 50 }
    );
    return c.json(
      {
        entries: entries.map((e) => ({
          id: e.id,
          title: e.title,
          body: e.body,
          labels: JSON.parse(e.labels) as string[],
          publishedAt: e.publishedAt,
        })),
      },
      200
    );
  });

  app.openapi(widgetIdeaRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { "x-pile-widget-session": sessionToken } = c.req.valid("header");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const widgetKey = await requireWidgetKey(db, key, c.req.header("origin"));
    const session = await requireWidgetSession(db, widgetKey, sessionToken);
    const customer = await requireSessionCustomer(db, widgetKey, session);

    const ticket = await createTicket(
      db,
      {
        organizationId: widgetKey.organizationId,
        customerId: customer.id,
        title: body.title,
        sourceChannel: "chat",
        externalSource: "chat",
      },
      c.env as WorkerEnv
    );
    await updateTicket(
      db,
      widgetKey.organizationId,
      ticket.id,
      { isPublic: true, actorType: "customer", actorId: customer.id },
      c.env as WorkerEnv
    );
    if (body.text) {
      await addTicketMessage(
        db,
        widgetKey.organizationId,
        ticket.id,
        {
          direction: "inbound",
          textContent: body.text,
          channel: "chat",
          customerId: customer.id,
          actorType: "customer",
          actorId: customer.id,
        },
        c.env as WorkerEnv
      );
    }
    // Authors implicitly vote for their own idea.
    const { vote } = await addTicketVote(
      db,
      widgetKey.organizationId,
      ticket.id,
      {
        voterEmail: customer.email,
        customerId: customer.id,
        castByActorType: "customer",
        castByActorId: customer.id,
      }
    );
    const votes = await listTicketVotes(
      db,
      widgetKey.organizationId,
      ticket.id
    );
    return c.json({ ticketId: vote.ticketId, voteCount: votes.length }, 201);
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

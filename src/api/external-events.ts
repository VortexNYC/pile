import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

// PILE-422 — inbound external events complete stage sub-steps (Finix
// merchant approved, Seal agreement signed, carrier delivered). A mapping
// binds (source, eventType) → stepKey + a payload matcher that resolves the
// record (deal/customer external_id, issue external_ref). Deliveries are
// HMAC-SHA256 verified against the mapping's secret — the signature is the
// credential, so the ingest route carries no workspace auth (the
// middleware bypass in index.ts mirrors the agent-session log-push seam).
// Every event lands a delivery row: the dedupe ledger and the audit log
// are the same table.

const entityTypeSchema = z.enum(["issue", "deal", "customer"]);

const externalEventMappingSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    source: z.string(),
    eventType: z.string(),
    entityType: entityTypeSchema,
    matchPath: z.string(),
    stepKey: z.string(),
    enabled: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ExternalEventMapping");

const createExternalEventMappingSchema = z
  .object({
    source: z.string().min(1),
    eventType: z.string().min(1),
    entityType: entityTypeSchema,
    matchPath: z
      .string()
      .min(1)
      .describe(
        'Dotted path into the event payload resolving to the record\'s external id — e.g. "data.merchant_id".'
      ),
    stepKey: z.string().min(1),
    secret: z
      .string()
      .min(1)
      .describe("HMAC-SHA256 signing secret for this source's deliveries."),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateExternalEventMappingSchema = z
  .object({
    source: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    entityType: entityTypeSchema.optional(),
    matchPath: z.string().min(1).optional(),
    stepKey: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const externalEventDeliverySchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    source: z.string(),
    eventType: z.string().nullable(),
    eventId: z.string().nullable(),
    dedupeKey: z.string(),
    status: z.string(),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    completedIssueIds: z.array(z.string()),
    payload: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("ExternalEventDelivery");

const ingestResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  deliveryId: z.string().optional(),
  outcome: z.string().optional(),
  completedIssueIds: z.array(z.string()).optional(),
});

/** The secret is write-only — responses carry every field but it. */
function toMappingResponse(row: {
  id: string;
  organizationId: string;
  source: string;
  eventType: string;
  entityType: "issue" | "deal" | "customer";
  matchPath: string;
  stepKey: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    eventType: row.eventType,
    entityType: row.entityType,
    matchPath: row.matchPath,
    stepKey: row.stepKey,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeliveryResponse(row: {
  id: string;
  organizationId: string;
  source: string;
  eventType: string | null;
  eventId: string | null;
  dedupeKey: string;
  status: string;
  entityType: string | null;
  entityId: string | null;
  completedIssueIds: string | null;
  payload: string | null;
  createdAt: string;
}) {
  let completedIssueIds: string[] = [];
  if (row.completedIssueIds) {
    try {
      const parsed: unknown = JSON.parse(row.completedIssueIds);
      if (Array.isArray(parsed)) {
        completedIssueIds = parsed.filter(
          (id): id is string => typeof id === "string"
        );
      }
    } catch {
      completedIssueIds = [];
    }
  }
  return { ...row, completedIssueIds };
}

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "External event mapping not found",
  });
}

const orgParam = z.object({ organizationId: z.string() });
const mappingIdParam = z.object({
  organizationId: z.string(),
  id: z.string(),
});

const ingestExternalEventRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/external-events/{source}",
  tags: ["external-events"],
  description:
    "Inbound provider webhook. The raw JSON body is verified with HMAC-SHA256 against the source's mapping secret — send the hex digest in any *-signature header (X-Pile-Signature, Finix-Signature, sha256=<hex>, or t=...,v1=<hex> envelopes all work). The provider event id for dedupe comes from a *-Event-Id header or the payload's id field.",
  request: {
    params: z.object({
      organizationId: z.string(),
      source: z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: z.record(z.string(), z.unknown()) },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Event received and recorded",
      content: { "application/json": { schema: ingestResultSchema } },
    },
    401: { description: "Invalid webhook signature" },
    404: { description: "External event source not configured" },
  },
});

const listExternalEventMappingsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/external-event-mappings",
  tags: ["external-events"],
  middleware: [rls("settings:view")],
  request: {
    params: orgParam,
    query: z.object({ source: z.string().optional() }),
  },
  responses: {
    200: {
      description: "External event mapping list",
      content: {
        "application/json": {
          schema: z.object({
            mappings: z.array(externalEventMappingSchema),
          }),
        },
      },
    },
  },
});

const createExternalEventMappingRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/external-event-mappings",
  tags: ["external-events"],
  middleware: [rls("settings:create")],
  description:
    "Bind an inbound provider event to a stage sub-step. source and stepKey slug-normalize; eventType is the provider's literal event name (\"*\" is a catch-all). The matcher resolves the payload at matchPath to the record's externalId (deal/customer) or externalRef (issue).",
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createExternalEventMappingSchema },
      },
    },
  },
  responses: {
    201: {
      description: "External event mapping created",
      content: {
        "application/json": {
          schema: z.object({ mapping: externalEventMappingSchema }),
        },
      },
    },
  },
});

const getExternalEventMappingRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/external-event-mappings/{id}",
  tags: ["external-events"],
  middleware: [rls("settings:view")],
  request: { params: mappingIdParam },
  responses: {
    200: {
      description: "External event mapping",
      content: {
        "application/json": {
          schema: z.object({ mapping: externalEventMappingSchema }),
        },
      },
    },
    404: { description: "External event mapping not found" },
  },
});

const updateExternalEventMappingRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/external-event-mappings/{id}",
  tags: ["external-events"],
  middleware: [rls("settings:edit")],
  request: {
    params: mappingIdParam,
    body: {
      content: {
        "application/json": { schema: updateExternalEventMappingSchema },
      },
    },
  },
  responses: {
    200: {
      description: "External event mapping updated",
      content: {
        "application/json": {
          schema: z.object({ mapping: externalEventMappingSchema }),
        },
      },
    },
    404: { description: "External event mapping not found" },
  },
});

const deleteExternalEventMappingRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/external-event-mappings/{id}",
  tags: ["external-events"],
  middleware: [rls("settings:delete")],
  request: { params: mappingIdParam },
  responses: {
    200: {
      description: "External event mapping deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "External event mapping not found" },
  },
});

const listExternalEventDeliveriesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/external-event-deliveries",
  tags: ["external-events"],
  middleware: [rls("settings:view")],
  description:
    "The inbound event ledger — every delivery lands one row recording its outcome (applied, already_done, no_step, no_record, unmapped, invalid_payload, invalid_signature). Replays return the original outcome without writing a row.",
  request: {
    params: orgParam,
    query: z.object({
      source: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: {
      description: "External event delivery log",
      content: {
        "application/json": {
          schema: z.object({
            deliveries: z.array(externalEventDeliverySchema),
          }),
        },
      },
    },
  },
});

export function registerExternalEventRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(ingestExternalEventRoute, async (c) => {
    const { organizationId, source } = c.req.valid("param");
    const body = await c.req.text();
    // Signature candidates: any header with "signature" in the name — the
    // DO tries each 64-hex token against the source's HMAC. Event-id
    // headers supply the dedupe key when the payload has no id.
    const signatures: string[] = [];
    let eventId: string | null = null;
    c.req.raw.headers.forEach((value, name) => {
      if (name.includes("signature")) {
        signatures.push(value);
      } else if (eventId === null && name.endsWith("event-id")) {
        eventId = value;
      } else if (eventId === null && name === "webhook-id") {
        eventId = value;
      }
    });
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const result = await stub.ingestExternalEvent({
      source,
      signatures,
      eventId,
      body,
    });
    if (result.status === "invalid_signature") {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid webhook signature",
      });
    }
    if (result.status === "unknown_source") {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External event source not configured",
      });
    }
    return c.json({ ok: true, ...result }, 200);
  });

  app.openapi(listExternalEventMappingsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { source } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const mappings = await stub.listExternalEventMappings({ source });
    return c.json({ mappings: mappings.map(toMappingResponse) }, 200);
  });

  app.openapi(createExternalEventMappingRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const mapping = await stub.createExternalEventMapping(body, {
      actorId: identity.id,
      actorType: identity.type,
    });
    return c.json({ mapping: toMappingResponse(mapping) }, 201);
  });

  app.openapi(getExternalEventMappingRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const mapping = await stub.getExternalEventMapping(id);
    if (!mapping) notFound();
    return c.json({ mapping: toMappingResponse(mapping) }, 200);
  });

  app.openapi(updateExternalEventMappingRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const mapping = await stub.updateExternalEventMapping(id, body, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!mapping) notFound();
    return c.json({ mapping: toMappingResponse(mapping) }, 200);
  });

  app.openapi(deleteExternalEventMappingRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const ok = await stub.deleteExternalEventMapping(id, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!ok) notFound();
    return c.json({ ok: true }, 200);
  });

  app.openapi(listExternalEventDeliveriesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { source, status, limit } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const deliveries = await stub.listExternalEventDeliveries({
      source,
      status,
      limit,
    });
    return c.json({ deliveries: deliveries.map(toDeliveryResponse) }, 200);
  });
}
